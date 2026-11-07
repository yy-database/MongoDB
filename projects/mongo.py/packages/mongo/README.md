# `yydb-mongo`

Python bindings for the MongoDB wire-protocol primitives in
`projects/mongo.rs`. The compiled extension is a thin layer over the Rust
crates: documents and replies travel as canonical Extended JSON strings, and a
`MongoStore` owns one `.yykv` shard.

```python
import json
import tempfile
import os

import mongo

store = mongo.MongoStore(os.path.join(tempfile.mkdtemp(), "mongo.yykv"))
mongo.insert(store, json.dumps({"insert": "probe", "documents": [{"_id": 1, "score": 10}]}))
reply = mongo.find(store, json.dumps({"find": "probe", "filter": {"_id": 1}}))
print(json.loads(reply))
```

Every exported function mirrors the `mongo-pyo3` signature one-to-one and
returns JSON encoded with the same canonical rules `mongod` uses
(`$numberInt`, `$numberDouble`, `$oid`, ...). This package does not ship a
server loop or a CLI: the listener is assembled in TypeScript from the same
primitives.

The package is private during the product build; it is not published to a
public index. Driver compatibility and the storage contract are documented in
the repository [readme.md](https://github.com/yy-database/MongoDB#readme).
