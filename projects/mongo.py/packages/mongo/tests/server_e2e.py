"""Client-compatibility acceptance from the Python driver.

Spawns the TypeScript listener and connects with the official driver while
compression is enabled, then runs a CRUD round trip. Expectations are pymongo's
own round-trip results, not values produced by this repository.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from pymongo import MongoClient

HERE = Path(__file__).resolve()
REPO = HERE.parents[5]
SERVER = REPO / "projects" / "mongo.ts" / "packages" / "mongo" / "bin" / "serve.mjs"

assertions = 0


def check(condition, message):
    global assertions
    assertions += 1
    if not condition:
        raise AssertionError(message)


def main():
    data_dir = tempfile.mkdtemp(prefix="mongo-py-server-")
    process = subprocess.Popen(
        [ "node", str(SERVER), "--data-dir", data_dir, "--port", "0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        line = process.stdout.readline()
        check(line != "", "the server printed its address")
        ready = json.loads(line)
        check(ready["ready"] is True, "the server is ready")
        uri = "mongodb://%s:%s/?directConnection=true" % (ready["host"], ready["port"])

        client = MongoClient(uri, compressors=["zlib"], serverSelectionTimeoutMS=5000, connectTimeoutMS=5000)
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
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    print("python server acceptance: %d assertions" % assertions)


if __name__ == "__main__":
    main()
