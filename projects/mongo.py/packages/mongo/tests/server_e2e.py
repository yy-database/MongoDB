"""Client-compatibility acceptance from the Python driver.

Spawns the TypeScript listener and connects with the official driver twice:
once with compression enabled and no credentials, once with authentication
enabled (``--auth``) for both SCRAM mechanisms. Expectations are pymongo's own
round-trip results, not values produced by this repository.
"""
import json
import subprocess
import tempfile
from pathlib import Path

from pymongo import MongoClient, ReadPreference, WriteConcern
from pymongo.errors import OperationFailure, ServerSelectionTimeoutError

HERE = Path(__file__).resolve()
REPO = HERE.parents[5]
SERVER = REPO / "projects" / "mongo.ts" / "packages" / "mongo" / "bin" / "serve.mjs"

assertions = 0


def check(condition, message):
    global assertions
    assertions += 1
    if not condition:
        raise AssertionError(message)


def spawn(extra=()):
    data_dir = tempfile.mkdtemp(prefix="mongo-py-server-")
    process = subprocess.Popen(
        ["node", str(SERVER), "--data-dir", data_dir, "--port", "0", *extra],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    line = process.stdout.readline()
    check(line != "", "the server printed its address")
    ready = json.loads(line)
    check(ready["ready"] is True, "the server is ready")
    return process, "mongodb://%s:%s" % (ready["host"], ready["port"])


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def compressed_round_trip(base_uri):
    client = MongoClient(
        base_uri + "/?directConnection=true",
        compressors=["zlib"],
        serverSelectionTimeoutMS=5000,
        connectTimeoutMS=5000,
    )
    try:
        collection = client["acceptance"]["python_compressed"]
        collection.delete_many({})
        inserted = collection.insert_many([{"_id": 1, "v": "a"}, {"_id": 2, "v": "b"}, {"_id": 3, "v": "c"}])
        check(len(inserted.inserted_ids) == 3, "insert under zlib")
        found = list(collection.find({}).sort("_id", 1))
        check([document["_id"] for document in found] == [1, 2, 3], "find under zlib")
        updated = collection.update_one({"_id": 2}, {"$set": {"v": "z"}})
        check(updated.modified_count == 1, "update under zlib")
        removed = collection.delete_one({"_id": 3})
        check(removed.deleted_count == 1, "delete under zlib")
        check(collection.count_documents({}) == 2, "count under zlib")
    finally:
        client.close()


def authenticated_round_trip(base_uri):
    bootstrap = MongoClient(base_uri + "/?directConnection=true", serverSelectionTimeoutMS=5000)
    try:
        bootstrap["admin"].command({"createUser": "root", "pwd": "root-pass", "roles": [{"role": "root", "db": "admin"}]})
    finally:
        bootstrap.close()

    for mechanism in ("SCRAM-SHA-256", "SCRAM-SHA-1"):
        uri = (
            base_uri.replace("mongodb://", "mongodb://root:root-pass@")
            + "/?authSource=admin&directConnection=true&authMechanism=" + mechanism + "&compressors=zlib"
        )
        client = MongoClient(uri, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000)
        try:
            collection = client["secured"]["python_auth"]
            collection.delete_many({})
            collection.insert_many([{"_id": 1, "v": "a"}, {"_id": 2, "v": "b"}])
            check([document["_id"] for document in collection.find({}).sort("_id", 1)] == [1, 2], "find after %s login" % mechanism)
            check(collection.update_one({"_id": 1}, {"$set": {"v": "z"}}).modified_count == 1, "update after %s login" % mechanism)
            status = client["admin"].command({"connectionStatus": 1})
            users = status["authInfo"]["authenticatedUsers"]
            check(users == [{"user": "root", "db": "admin"}], "%s login is reported by connectionStatus" % mechanism)
        finally:
            client.close()

    bad_uri = (
        base_uri.replace("mongodb://", "mongodb://root:wrong-pass@")
        + "/?authSource=admin&directConnection=true"
    )
    bad = MongoClient(bad_uri, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000)
    try:
        bad["admin"].command({"ping": 1})
    except OperationFailure as error:
        check(error.details.get("code") == 18, "a wrong password fails with code 18")
        check(error.details.get("errmsg") == "Authentication failed.", "a wrong password uses the real failure text")
    else:
        raise AssertionError("a wrong password was accepted")
    finally:
        bad.close()


def replica_set_round_trip():
    """A real driver against a single-member set: write concern, oplog, reads."""
    process, base_uri = spawn(("--repl-set", "probers"))
    try:
        direct = MongoClient(base_uri + "/?directConnection=true", serverSelectionTimeoutMS=5000, connectTimeoutMS=5000)
        try:
            direct["admin"].command({"replSetInitiate": {}})
            collection = direct["acceptance"]["python_rs"]
            collection.insert_one({"_id": 1, "v": "a"})

            satisfied = collection.with_options(
                write_concern=WriteConcern(w="majority", j=True)
            ).insert_one({"_id": 2})
            check(satisfied.acknowledged, "majority is satisfied by the one member")

            unsupported = direct["acceptance"].command(
                {"insert": "python_rs", "documents": [{"_id": 3}], "writeConcern": {"w": 2}}
            )
            check(unsupported["ok"] == 1, "an unsatisfiable w still applies the write")
            check(unsupported["writeConcernError"]["code"] == 100, "w: 2 reports UnsatisfiableWriteConcern")
            check(
                unsupported["writeConcernError"]["errmsg"] == "Not enough data-bearing nodes",
                "the unsatisfiable text matches mongod",
            )

            unknown = direct["acceptance"].command(
                {"insert": "python_rs", "documents": [{"_id": 4}], "writeConcern": {"w": "tag"}}
            )
            check(unknown["ok"] == 1, "an unknown tag still applies the write")
            check(unknown["writeConcernError"]["code"] == 79, "an unknown tag is UnknownReplWriteConcern")

            unacknowledged = collection.with_options(write_concern=WriteConcern(w=0)).insert_one({"_id": 5})
            check(unacknowledged.acknowledged is False, "w: 0 is not acknowledged by the driver")
            check(collection.count_documents({}) == 5, "the unacknowledged write still landed")

            entry = direct["local"]["oplog.rs"].find_one({"ns": "acceptance.python_rs"})
            check(entry is not None, "the insert produced an oplog entry")
            check(entry["op"] == "i", "the insert entry uses op i")
            check(entry["o"] == {"_id": 1, "v": "a"}, "the insert entry stores the document")
            check(entry["o2"] == {"_id": 1}, "the insert entry carries the id in o2")
            check(entry["v"] == 2, "the entry carries v: 2")
            check("h" not in entry, "8.0.9 no longer writes the h field")

            dropped = direct["acceptance"].command({"drop": "python_rs"})
            check(dropped["nIndexesWas"] == 1, "drop counts the id index")
            check(dropped["ns"] == "acceptance.python_rs", "drop names its namespace")

            try:
                direct["local"].drop_collection("oplog.rs")
            except OperationFailure as error:
                check(error.details.get("code") == 5255000, "the live oplog cannot be dropped")
            else:
                raise AssertionError("the live oplog was dropped")
        finally:
            direct.close()

        client = MongoClient(base_uri + "/?replicaSet=probers", serverSelectionTimeoutMS=3000, connectTimeoutMS=3000)
        try:
            check(client["admin"].command({"ping": 1})["ok"] == 1, "the driver reaches the set")
            check(
                client.topology_description.topology_type_name == "ReplicaSetWithPrimary",
                "the driver discovers a single-member replica set",
            )
            try:
                client["acceptance"]["python_rs"].with_options(
                    read_preference=ReadPreference.SECONDARY
                ).find_one({})
            except ServerSelectionTimeoutError:
                pass
            else:
                raise AssertionError("a secondary read must not be answered by the primary")
        finally:
            client.close()
    finally:
        stop(process)


def main():
    process, base_uri = spawn()
    try:
        compressed_round_trip(base_uri)
    finally:
        stop(process)

    process, base_uri = spawn(("--auth",))
    try:
        authenticated_round_trip(base_uri)
    finally:
        stop(process)

    replica_set_round_trip()

    print("python server acceptance: %d assertions" % assertions)


if __name__ == "__main__":
    main()
