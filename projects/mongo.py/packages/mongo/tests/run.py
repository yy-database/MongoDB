# Python-side acceptance runner.
#
# Executes exactly the same `tests/cases/*.json` corpus as the TypeScript runner,
# through the installed package (`mongo` -> `mongo_pyo3`). Expected values are
# literals in the case files (BSON specification layouts and MongoDB semantics),
# never a second call into this implementation.
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[5]
sys.path.insert(0, str(HERE.parents[1]))

import mongo  # noqa: E402

CASE_DIR = REPO / "tests" / "cases"
YYDS_VERIFIER = REPO / "scripts" / "verify-yyds.mjs"
OUTPUT = Path(os.environ.get("MONGO_TEST_OUT", REPO / ".tmp" / "test-results" / "py.json"))
MISSING = object()


def stable(value):
    if isinstance(value, list):
        return "[" + ",".join(stable(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(f"{json.dumps(key)}:{stable(value[key])}" for key in sorted(value))
            + "}"
        )
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def walk(node, segments):
    if not segments:
        return node
    head, rest = segments[0], segments[1:]
    if node is None:
        return MISSING
    if isinstance(node, list):
        if head == "#":
            return len(node)
        if head == "*":
            mapped = [walk(item, rest) for item in node]
            return MISSING if any(item is MISSING for item in mapped) else mapped
        if head.isdigit():
            index = int(head)
            return walk(node[index], rest) if index < len(node) else MISSING
        return MISSING
    if isinstance(node, dict):
        if head == "#":
            return len(node)
        if head not in node:
            return MISSING
        return walk(node[head], rest)
    if isinstance(node, str) and head == "#":
        return len(node)
    return MISSING


def build_synthetic(spec):
    if spec["kind"] == "large":
        document = {"_id": {"$numberInt": "9001"}}
        for index in range(spec.get("fields", 1)):
            document[f"f{index}"] = {"$numberInt": str(index)}
        document["pad"] = "x" * spec["bytes"]
        return document
    if spec["kind"] == "deep":
        node = {"v": {"$numberInt": "1"}}
        for _ in range(spec["depth"]):
            node = {"child": node}
        return {"_id": {"$numberInt": "9002"}, "deep": node}
    if spec["kind"] == "wide":
        document = {"_id": {"$numberInt": "9003"}}
        for index in range(spec["fields"]):
            document[f"f{index:04d}"] = {"$numberInt": str(index)}
        return document
    if spec["kind"] == "series":
        return [
            {"_id": {"$numberInt": str(spec.get("offset", 0) + index)}, "v": f"v{spec.get('offset', 0) + index}"}
            for index in range(spec["count"])
        ]
    raise ValueError(f"unknown synthetic kind {spec['kind']}")


def command_of(case, step, command):
    if case.get("noDb"):
        return command
    enriched = dict(command)
    for key in ("lsid", "txnNumber", "startTransaction", "autocommit"):
        if key in step:
            enriched[key] = step[key]
    enriched["$db"] = step.get("db", case.get("db", "app"))
    return enriched


# ---------------------------------------------------------------------------
# Semantic-equivalence runner for the `cli` surface.
#
# The CLI itself is `projects/mongo.ts/packages/mongo/bin/mongo.mjs` and only
# the TypeScript runner executes that process. This side re-implements the same
# line grammar on top of the pyo3 primitives so both bindings must agree on the
# resulting documents. It is *not* the same entry point: it proves that the
# primitives compose to the same observable behaviour, not that Python hosts a
# shell.
# ---------------------------------------------------------------------------
CLI_NAMES = [
    "use",
    "show dbs",
    "show collections",
    "insertOne",
    "insertMany",
    "find",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany",
    "countDocuments",
    "aggregate",
    "exit",
    "quit",
]


class CliError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def cli_unknown(label):
    return f"unknown command: {label} (supported: {', '.join(CLI_NAMES)})"


def cli_argument(piece):
    token = piece.strip()
    if not token:
        raise CliError(2, "empty argument")
    if token in ("true", "false", "null"):
        return json.loads(token)
    if re.match(r"^[A-Za-z_$][A-Za-z0-9_$-]*$", token):
        return token
    try:
        return json.loads(token)
    except ValueError:
        raise CliError(2, f"invalid JSON argument: {token}") from None


def cli_arguments(text):
    if not text.strip():
        return []
    pieces = []
    depth = 0
    start = 0
    in_string = False
    escaped = False
    for index, character in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
            continue
        if character in "{[(":
            depth += 1
        elif character in "}])":
            depth -= 1
        elif character == "," and depth == 0:
            pieces.append(text[start:index])
            start = index + 1
    if in_string or depth != 0:
        raise CliError(2, "unbalanced argument list")
    pieces.append(text[start:])
    return [cli_argument(piece) for piece in pieces]


def cli_group(text, start):
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        character = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
            continue
        if character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:index], index + 1
    raise CliError(2, "unbalanced parentheses")


def cli_call(text, start):
    match = re.match(r"^[A-Za-z_$][A-Za-z0-9_$]*", text[start:])
    if not match:
        return None
    name = match.group(0)
    index = start + len(name)
    while index < len(text) and text[index] == " ":
        index += 1
    if index >= len(text) or text[index] != "(":
        return None
    content, next_index = cli_group(text, index)
    return {"name": name, "args": cli_arguments(content), "next": next_index}


def cli_call_form(text):
    head = cli_call(text, 0)
    if not head:
        return None
    calls = []
    index = head["next"]
    while True:
        while index < len(text) and text[index] == " ":
            index += 1
        if index >= len(text):
            break
        if text[index] != ".":
            raise CliError(2, f"unexpected input: {text[index:]}")
        index += 1
        while index < len(text) and text[index] == " ":
            index += 1
        call = cli_call(text, index)
        if not call:
            raise CliError(2, f"invalid find method: {text[index:]}")
        calls.append(call)
        index = call["next"]
    return {"name": head["name"], "args": head["args"], "calls": calls}


def cli_document(value):
    return isinstance(value, dict)


def cli_collection(args, index, command):
    if index >= len(args) or not isinstance(args[index], str) or args[index] == "":
        raise CliError(2, f"{command} requires a collection name as argument {index + 1}")
    return args[index]


def cli_document_arg(args, index, command, label):
    if index >= len(args) or not cli_document(args[index]):
        raise CliError(2, f"{command} requires a {label} as argument {index + 1}")
    return args[index]


def cli_count(args, minimum, maximum, command):
    if len(args) < minimum or len(args) > maximum:
        expected = str(minimum) if minimum == maximum else f"{minimum}..{maximum}"
        raise CliError(2, f"{command} expects {expected} argument(s), got {len(args)}")


def cli_no_chain(call):
    if call["calls"]:
        raise CliError(2, f"{call['name']} does not accept chained methods")


class CliSession:
    """Port of `Session` in `bin/mongo.mjs`, over the pyo3 primitives."""

    def __init__(self, store, database):
        self.store = store
        self.database = database
        self.cursors = mongo.MongoCursors()

    def run(self, line):
        text = line.strip()
        if not text or text.startswith("//") or text.startswith("#"):
            return None
        if text in ("exit", "quit"):
            return {"ok": {"$numberInt": "1"}, "bye": True}, True
        if text == "show dbs":
            return json.loads(mongo.list_databases(self.store)), False
        if text == "show collections":
            command = {"listCollections": 1, "$db": self.database}
            return json.loads(mongo.list_collections(self.store, json.dumps(command))), False
        if text == "show" or text.startswith("show "):
            raise CliError(59, cli_unknown(text))
        if text == "use" or text.startswith("use "):
            name = text[3:].strip()
            if re.match(r"^[A-Za-z0-9_-]+$", name) is None:
                raise CliError(2, "use expects a single database name")
            self.database = name
            return {"ok": {"$numberInt": "1"}, "db": name}, False
        call = cli_call_form(text)
        if not call:
            raise CliError(59, cli_unknown(text))
        return self.dispatch(call), False

    def dispatch(self, call):
        name = call["name"]
        args = call["args"]
        database = self.database
        if name == "insertOne":
            cli_no_chain(call)
            cli_count(args, 2, 2, name)
            collection = cli_collection(args, 0, name)
            document = cli_document_arg(args, 1, name, "document")
            command = {"insert": collection, "documents": [document], "$db": database}
            return json.loads(mongo.insert(self.store, json.dumps(command)))
        if name == "insertMany":
            cli_no_chain(call)
            if len(args) < 2:
                raise CliError(2, "insertMany expects a collection name and at least one document")
            collection = cli_collection(args, 0, name)
            documents = args[1] if len(args) == 2 and isinstance(args[1], list) else args[1:]
            if not documents:
                raise CliError(2, "insertMany requires at least one document")
            for document in documents:
                if not cli_document(document):
                    raise CliError(2, "insertMany documents must be objects")
            command = {"insert": collection, "documents": documents, "$db": database}
            return json.loads(mongo.insert(self.store, json.dumps(command)))
        if name == "find":
            return self.find(call)
        if name in ("updateOne", "updateMany"):
            cli_no_chain(call)
            cli_count(args, 3, 3, name)
            collection = cli_collection(args, 0, name)
            filter_value = cli_document_arg(args, 1, name, "filter")
            update_value = cli_document_arg(args, 2, name, "update")
            updates = [{"q": filter_value, "u": update_value, "multi": name == "updateMany"}]
            command = {"update": collection, "updates": updates, "$db": database}
            return json.loads(mongo.update(self.store, json.dumps(command)))
        if name in ("deleteOne", "deleteMany"):
            cli_no_chain(call)
            cli_count(args, 1, 2, name)
            collection = cli_collection(args, 0, name)
            filter_value = cli_document_arg(args, 1, name, "filter") if len(args) > 1 else {}
            deletes = [{"q": filter_value, "limit": 1 if name == "deleteOne" else 0}]
            command = {"delete": collection, "deletes": deletes, "$db": database}
            return json.loads(mongo.delete(self.store, json.dumps(command)))
        if name == "countDocuments":
            cli_no_chain(call)
            cli_count(args, 1, 2, name)
            collection = cli_collection(args, 0, name)
            query = cli_document_arg(args, 1, name, "filter") if len(args) > 1 else {}
            command = {"count": collection, "query": query, "$db": database}
            return json.loads(mongo.count(self.store, json.dumps(command)))
        if name == "aggregate":
            cli_no_chain(call)
            cli_count(args, 2, 2, name)
            collection = cli_collection(args, 0, name)
            if not isinstance(args[1], list):
                raise CliError(2, "aggregate expects a pipeline array as argument 2")
            command = {"aggregate": collection, "pipeline": args[1], "cursor": {}, "$db": database}
            return json.loads(mongo.aggregate(self.store, json.dumps(command)))
        raise CliError(59, cli_unknown(name))

    def find(self, call):
        args = call["args"]
        cli_count(args, 1, 3, "find")
        collection = cli_collection(args, 0, "find")
        filter_value = cli_document_arg(args, 1, "find", "filter") if len(args) > 1 else {}
        command = {"find": collection, "filter": filter_value, "$db": self.database}
        if len(args) > 2:
            command["projection"] = cli_document_arg(args, 2, "find", "projection")
        seen = set()
        for method in call["calls"]:
            if method["name"] in seen:
                raise CliError(2, f"find method {method['name']} used twice")
            seen.add(method["name"])
            if method["name"] == "sort":
                cli_count(method["args"], 1, 1, "sort")
                command["sort"] = cli_document_arg(method["args"], 0, "sort", "sort")
            elif method["name"] in ("skip", "limit"):
                cli_count(method["args"], 1, 1, method["name"])
                value = method["args"][0]
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or int(value) != value:
                    raise CliError(2, f"{method['name']} expects a non-negative integer")
                command[method["name"]] = int(value)
            else:
                raise CliError(2, f"unknown find method: {method['name']}")
        return json.loads(mongo.find(self.store, self.cursors, json.dumps(command)))


def run_cli(directory, step):
    data_dir = os.path.join(directory, step.get("dir", "data"))
    os.makedirs(data_dir, exist_ok=True)
    session = CliSession(mongo.MongoStore(os.path.join(data_dir, "mongo.yykv")), step.get("db", "app"))
    lines = []
    for line in step["commands"]:
        try:
            outcome = session.run(line)
        except CliError as error:
            lines.append({"ok": {"$numberDouble": "0.0"}, "code": {"$numberInt": str(error.code)}, "errmsg": str(error)})
            continue
        if outcome is None:
            continue
        result, stop = outcome
        lines.append(result)
        if stop:
            break
    return {"exitCode": 0, "lines": lines}


def run_case(case):
    directory = tempfile.mkdtemp(prefix=f"mongo-py-{re.sub(r'[^\\w.-]+', '-', case['id'])}-")
    stores = {}
    cursors = []

    def store_of(name="s"):
        name = name or "s"
        if name not in stores:
            raise RuntimeError(f"store {name} is not open")
        return stores[name]["handle"]

    def file_of(name="s"):
        name = name or "s"
        if name not in stores:
            raise RuntimeError(f"store {name} is not open")
        return stores[name]["path"]

    def cursor_table():
        if not cursors:
            cursors.append(mongo.MongoCursors())
        return cursors[0]

    def execute(step):
        op = step["op"]
        if op == "open":
            name = step.get("store", "s")
            path = os.path.join(directory, f"{name}.yykv")
            stores[name] = {"path": path, "handle": mongo.MongoStore(path)}
            return {"path": path}
        if op == "reopen":
            name = step.get("store", "s")
            entry = stores[name]
            entry["handle"] = mongo.MongoStore(entry["path"])
            return {"path": entry["path"]}
        if op == "close":
            stores.pop(step.get("store", "s"), None)
            return None
        if op == "fileSize":
            return os.stat(file_of(step.get("store"))).st_size
        if op == "dataFiles":
            return sorted(os.listdir(directory))
        if op == "insert":
            command = {"insert": step["collection"]}
            if not step.get("omitDocuments"):
                if "synthetic" in step:
                    built = build_synthetic(step["synthetic"])
                    documents = built if isinstance(built, list) else [built]
                else:
                    documents = step["documents"]
                command["documents"] = documents
            if "ordered" in step:
                command["ordered"] = step["ordered"]
            return json.loads(mongo.insert(store_of(step.get("store")), json.dumps(command_of(case, step, command))))
        if op == "find":
            command = {"find": step["collection"]}
            for key in ("filter", "projection", "sort", "skip", "limit", "batchSize", "hint"):
                if key in step:
                    command[key] = step[key]
            reply = mongo.find(store_of(step.get("store")), cursor_table(), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "count":
            command = {"count": step["collection"]}
            for key in ("query", "skip", "limit", "hint"):
                if key in step:
                    command[key] = step[key]
            reply = mongo.count(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "explain":
            command = {"explain": step["explain"]}
            if "verbosity" in step:
                command["verbosity"] = step["verbosity"]
            reply = mongo.explain(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "aggregate":
            command = {"aggregate": step["collection"], "pipeline": step["pipeline"], "cursor": {}}
            reply = mongo.aggregate(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "delete":
            command = {"delete": step["collection"], "deletes": step["deletes"]}
            reply = mongo.delete(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "update":
            command = {"update": step["collection"], "updates": step["updates"]}
            reply = mongo.update(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "getMore":
            command = {"getMore": step.get("id"), "collection": step["collection"]}
            if "batchSize" in step:
                command["batchSize"] = step["batchSize"]
            reply = mongo.get_more(cursor_table(), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "killCursors":
            command = {"killCursors": step["collection"], "cursors": step["ids"]}
            reply = mongo.kill_cursors(cursor_table(), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "findAndModify":
            command = {"findAndModify": step["collection"]}
            for key in ("query", "sort", "remove", "update", "new", "fields", "upsert"):
                if key in step:
                    command[key] = step[key]
            reply = mongo.find_and_modify(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "distinct":
            command = {"distinct": step["collection"], "key": step["key"]}
            if "query" in step:
                command["query"] = step["query"]
            reply = mongo.distinct(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "bulkWrite":
            command = {"bulkWrite": 1, "ops": step["ops"]}
            if "nsInfo" in step:
                command["nsInfo"] = step["nsInfo"]
            if "ordered" in step:
                command["ordered"] = step["ordered"]
            if "errorsOnly" in step:
                command["errorsOnly"] = step["errorsOnly"]
            # `bulkWrite` is only accepted against `admin`; the namespaces it
            # writes are taken from `nsInfo`.
            reply = mongo.bulk_write(
                store_of(step.get("store")),
                json.dumps(command_of(case, {**step, "db": step.get("db", "admin")}, command)),
            )
            return json.loads(reply)
        if op == "create":
            command = {"create": step["collection"]}
            for key in ("validator", "validationLevel", "validationAction"):
                if key in step:
                    command[key] = step[key]
            reply = mongo.create(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "collMod":
            command = {"collMod": step["collection"]}
            for key in ("validator", "validationLevel", "validationAction"):
                if key in step:
                    command[key] = step[key]
            reply = mongo.coll_mod(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "listCollections":
            command = {"listCollections": 1}
            for key in ("filter", "nameOnly", "authorizedCollections"):
                if key in step:
                    command[key] = step[key]
            reply = mongo.list_collections(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "commitTransaction":
            command = {"commitTransaction": 1}
            reply = mongo.commit_transaction(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "abortTransaction":
            command = {"abortTransaction": 1}
            reply = mongo.abort_transaction(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "createIndexes":
            command = {"createIndexes": step["collection"]}
            if not step.get("omitIndexes"):
                command["indexes"] = step["indexes"]
            reply = mongo.create_indexes(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "listIndexes":
            command = {"listIndexes": step["collection"]}
            reply = mongo.list_indexes(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "dropIndexes":
            command = {"dropIndexes": step["collection"]}
            if "index" in step:
                command["index"] = step["index"]
            reply = mongo.drop_indexes(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "setTtlMonitorSleepSecs":
            # `ttlMonitorSleepSecs` is a server setting, not a command.
            mongo.set_ttl_monitor_sleep_seconds(store_of(step.get("store")), step["seconds"])
            return None
        if op == "ttlMonitor":
            # `now_ms` is the caller-supplied clock that compresses the window.
            return json.loads(mongo.ttl_monitor(store_of(step.get("store")), step.get("nowMs")))
        if op == "dropDatabase":
            command = {"dropDatabase": step.get("argument", 1)}
            reply = mongo.drop_database(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "dropCollection":
            command = {"drop": step.get("argument", step.get("collection"))}
            reply = mongo.drop_collection(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "dbStats":
            command = {"dbStats": 1}
            if "scale" in step:
                command["scale"] = step["scale"]
            # `fsUsed` / `fsTotal` are host-measured filesystem bytes; both stay
            # `None` when the database does not exist.
            reply = mongo.db_stats(
                store_of(step.get("store")),
                json.dumps(command_of(case, step, command)),
                step.get("fsUsed"),
                step.get("fsTotal"),
            )
            return json.loads(reply)
        if op == "collStats":
            command = {"collStats": step["collection"]}
            if "scale" in step:
                command["scale"] = step["scale"]
            reply = mongo.coll_stats(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "listDatabases":
            return json.loads(mongo.list_databases(store_of(step.get("store"))))
        if op == "hello":
            return json.loads(mongo.hello())
        if op == "ping":
            return json.loads(mongo.ping())
        if op == "errorReply":
            return json.loads(mongo.error_reply(step["code"], step["message"]))
        if op == "commandName":
            return mongo.command_name(json.dumps(step["document"]))
        if op == "commandNameRaw":
            return mongo.command_name(step["text"])
        if op == "encodeDocument":
            return mongo.encode_document(json.dumps(step["document"])).hex()
        if op == "encodeDocumentRaw":
            return mongo.encode_document(step["text"]).hex()
        if op == "decodeDocument":
            return json.loads(mongo.decode_document(bytes.fromhex(step["hex"])))
        if op == "encodeOpMsg":
            return mongo.encode_op_msg(json.dumps(step["document"])).hex()
        if op == "decodeOpMsg":
            return json.loads(mongo.decode_op_msg(bytes.fromhex(step["hex"])))
        if op == "decodeOpQuery":
            return json.loads(mongo.decode_op_query(bytes.fromhex(step["hex"])))
        if op == "importBson":
            return mongo.import_bson(store_of(step.get("store")), step["namespace"], bytes.fromhex(step["hex"]))
        if op == "importBsonFile":
            path = os.path.join(directory, f"{step.get('file', 'dump')}.bson")
            with open(path, "wb") as handle:
                handle.write(bytes.fromhex(step["hex"]))
            return mongo.import_bson_file(store_of(step.get("store")), step["namespace"], path)
        if op == "cursorsLen":
            return len(cursor_table())
        if op == "writeBytes":
            target = os.path.join(directory, step["path"])
            with open(target, "wb") as file:
                file.write(bytes.fromhex(step["hex"]))
            return None
        if op == "readBytes":
            with open(os.path.join(directory, step["path"]), "rb") as file:
                return file.read().hex()
        if op == "removeFile":
            try:
                os.remove(os.path.join(directory, step["path"]))
            except FileNotFoundError:
                pass
            return None
        if op == "verifyCatalog":
            node = shutil.which("node") or "node"
            run = subprocess.run(
                [node, str(YYDS_VERIFIER), os.path.join(directory, step["path"])],
                capture_output=True,
                text=True,
                check=False,
            )
            if run.returncode != 0:
                raise RuntimeError(f"yyds verifier exited with {run.returncode}: {run.stderr}")
            return json.loads(run.stdout)
        if op == "repairShard":
            return json.loads(mongo.repair_shard(os.path.join(directory, f"{step.get('store', 's')}.yykv")))
        if op == "cli":
            return run_cli(directory, step)
        raise ValueError(f"unknown case op {op}")

    outputs = {}
    started = time.perf_counter()
    try:
        for step in case["program"]:
            name = step.get("as")
            try:
                value = execute(step)
                if name:
                    outputs[name] = value
            except Exception as error:  # noqa: BLE001 - parity needs the rejection text
                if name:
                    outputs[name] = {"__threw": f"{error}"}
    finally:
        elapsed_ms = (time.perf_counter() - started) * 1000
        shutil.rmtree(directory, ignore_errors=True)

    failures = []
    assertions = 0
    for check in case["checks"]:
        assertions += 1
        result = evaluate(check, outputs, elapsed_ms)
        if not result["pass"]:
            failures.append({"case": case["id"], "check": check, "expected": result["expected"], "actual": result["actual"]})

    return {
        "id": case["id"],
        "surface": case["surface"],
        "assertions": assertions,
        "failures": failures,
        "outputs": {key: stable(value) for key, value in outputs.items()},
        "elapsedMs": round(elapsed_ms, 3),
    }


def evaluate(check, outputs, elapsed_ms):
    if "elapsedLt" in check:
        return {"pass": elapsed_ms < check["elapsedLt"], "expected": f"< {check['elapsedLt']}ms", "actual": f"{elapsed_ms}ms"}
    root_name, *rest = check["at"].lstrip("/").split("/")
    root = outputs.get(root_name, MISSING)
    actual = MISSING if root is MISSING else walk(root, rest)
    describe = lambda value: "<missing>" if value is MISSING else value  # noqa: E731

    if check.get("throws") is True:
        threw = isinstance(root, dict) and "__threw" in root
        return {"pass": threw, "expected": "throws", "actual": describe(root)}
    if "errorContains" in check:
        message = root.get("__threw", "") if isinstance(root, dict) and "__threw" in root else ""
        return {
            "pass": check["errorContains"] in str(message),
            "expected": f"error contains {check['errorContains']}",
            "actual": message or describe(root),
        }
    if isinstance(root, dict) and "__threw" in root:
        return {"pass": False, "expected": check.get("equals", "value"), "actual": f"threw: {root['__threw']}"}
    if check.get("absent") is True:
        return {"pass": actual is MISSING, "expected": "<missing>", "actual": describe(actual)}
    if "matches" in check:
        passed = isinstance(actual, str) and re.search(check["matches"], actual) is not None
        return {"pass": passed, "expected": f"/{check['matches']}/", "actual": describe(actual)}
    if "equals" in check:
        passed = actual is not MISSING and stable(actual) == stable(check["equals"])
        return {"pass": passed, "expected": check["equals"], "actual": describe(actual)}
    for operator, comparison in (
        ("gte", lambda left, right: left >= right),
        ("lte", lambda left, right: left <= right),
        ("gt", lambda left, right: left > right),
        ("lt", lambda left, right: left < right),
    ):
        if operator in check:
            passed = isinstance(actual, (int, float)) and comparison(actual, check[operator])
            return {"pass": passed, "expected": f"{operator} {check[operator]}", "actual": describe(actual)}
    raise ValueError(f"unsupported check {check}")


cases = []
for path in sorted(CASE_DIR.glob("*.json")):
    payload = json.loads(path.read_text(encoding="utf-8"))
    for case in payload["cases"]:
        case["file"] = path.name
        cases.append(case)

results = [run_case(case) for case in cases]
total_assertions = sum(item["assertions"] for item in results)
failed = [failure for item in results for failure in item["failures"]]

surfaces = {}
for item in results:
    stats = surfaces.setdefault(item["surface"], {"cases": 0, "assertions": 0})
    stats["cases"] += 1
    stats["assertions"] += item["assertions"]

summary = {
    "language": "py",
    "binding": "yydb-mongo (mongo_pyo3)",
    "cases": len(results),
    "assertions": total_assertions,
    "passed": total_assertions - len(failed),
    "failed": len(failed),
    "skipped": 0,
    "surfaces": surfaces,
    "failures": failed,
    "results": results,
}

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

print(f"py: {len(results)} cases, {total_assertions} assertions, {len(failed)} failed")
for surface, stats in surfaces.items():
    print(f"  {surface}: {stats['cases']} cases / {stats['assertions']} assertions")
for failure in failed[:40]:
    print(f"FAIL {failure['case']} {failure['check'].get('at', '')} expected={stable(failure['expected'])} actual={stable(failure['actual'])}")
if len(failed) > 40:
    print(f"... {len(failed) - 40} more failures")

sys.exit(1 if failed else 0)
