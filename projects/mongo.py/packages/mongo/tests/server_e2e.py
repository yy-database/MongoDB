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

from pymongo import MongoClient
from pymongo.errors import OperationFailure

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

    print("python server acceptance: %d assertions" % assertions)


if __name__ == "__main__":
    main()
