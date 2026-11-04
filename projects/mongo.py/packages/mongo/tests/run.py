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
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[5]
sys.path.insert(0, str(HERE.parents[1]))

import mongo  # noqa: E402

CASE_DIR = REPO / "tests" / "cases"
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
    enriched["$db"] = step.get("db", case.get("db", "app"))
    return enriched


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
            for key in ("filter", "sort", "skip", "limit", "batchSize"):
                if key in step:
                    command[key] = step[key]
            reply = mongo.find(store_of(step.get("store")), cursor_table(), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "count":
            command = {"count": step["collection"]}
            for key in ("query", "skip", "limit"):
                if key in step:
                    command[key] = step[key]
            reply = mongo.count(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "aggregate":
            command = {"aggregate": step["collection"], "pipeline": step["pipeline"], "cursor": {}}
            reply = mongo.aggregate(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
            return json.loads(reply)
        if op == "delete":
            command = {"delete": step["collection"], "deletes": step["deletes"]}
            reply = mongo.delete(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
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
        if op == "listCollections":
            command = {"listCollections": 1}
            if "filter" in step:
                command["filter"] = step["filter"]
            reply = mongo.list_collections(store_of(step.get("store")), json.dumps(command_of(case, step, command)))
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
        case["source"] = path.name
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
