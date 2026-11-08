// Minimal OP_MSG client built on the product's native codec.
//
// The product exposes a server and a BSON codec, not a high-level client. This
// module connects one TCP socket, sends one command at a time, and decodes the
// reply with `binding.decodeOpMsg`. It is the "our side" of the comparison and
// the conformance peer of the official `mongodb` driver.
import net from "node:net";

import { binding } from "../../../packages/mongo/dist/binding.js";

const OP_MSG = 2013;
const HEADER_SIZE = 16;

const NUMBER_KEYS = ["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"];

/** Unwraps one extended-JSON numeric value (cursor ids, reply counts, `ok`). */
export function numberValue(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    for (const key of NUMBER_KEYS) {
      if (Object.hasOwn(value, key)) return Number(value[key]);
    }
  }
  return 0;
}

/** Recursively converts extended JSON returned by the native codec into plain JS values. */
export function toPlain(value) {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const key = keys[0];
      if (NUMBER_KEYS.includes(key)) return Number(value[key]);
      if (key === "$oid") return value[key];
      if (key === "$date") return toPlain(value[key]);
    }
    const plain = {};
    for (const [key, entry] of Object.entries(value)) plain[key] = toPlain(entry);
    return plain;
  }
  return value;
}

function frame(payload, requestId) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeInt32LE(HEADER_SIZE + payload.length, 0);
  header.writeInt32LE(requestId, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(OP_MSG, 12);
  return Buffer.concat([header, payload]);
}

export class OpMsgClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.requestId = 1;
    this.closed = false;
  }

  static async connect(port, host = "127.0.0.1") {
    const client = new OpMsgClient();
    await client.open(port, host);
    const hello = await client.command({ hello: 1, $db: "admin" });
    if (numberValue(hello.ok) !== 1) {
      throw new Error(`hello failed: ${JSON.stringify(hello)}`);
    }
    return client;
  }

  open(port, host) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      this.socket = socket;
      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.pump();
      });
      socket.on("close", () => {
        if (!this.closed) this.fail(new Error("connection closed"));
      });
      socket.once("connect", () => {
        socket.off("error", reject);
        socket.on("error", (error) => this.fail(error));
        resolve();
      });
      socket.once("error", reject);
    });
  }

  fail(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next() {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("client is closed"));
        return;
      }
      this.waiters.push({ resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.waiters.length > 0 && this.buffer.length >= HEADER_SIZE) {
      const length = this.buffer.readInt32LE(0);
      if (this.buffer.length < length) return;
      const message = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      this.waiters.shift().resolve(message);
    }
  }

  async command(body) {
    if (this.closed) throw new Error("client is closed");
    const payload = binding.encodeOpMsg(JSON.stringify(body));
    this.socket.write(frame(payload, this.requestId++));
    const message = await this.next();
    const reply = JSON.parse(binding.decodeOpMsg(message.subarray(HEADER_SIZE)));
    if (numberValue(reply.ok) !== 1) {
      const error = new Error(reply.errmsg ?? "command failed");
      error.code = numberValue(reply.code);
      error.reply = reply;
      throw error;
    }
    return reply;
  }

  async insert(db, collection, documents) {
    return this.command({ insert: collection, documents, $db: db });
  }

  async find(db, collection, filter = {}, options = {}) {
    const reply = await this.command({ find: collection, filter, $db: db, ...options });
    const cursor = reply.cursor ?? {};
    const documents = [...(cursor.firstBatch ?? [])];
    let id = numberValue(cursor.id);
    while (id !== 0) {
      const more = await this.command({ getMore: id, collection, $db: db });
      documents.push(...(more.cursor?.nextBatch ?? []));
      id = numberValue(more.cursor?.id);
    }
    return documents;
  }

  async findOne(db, collection, filter) {
    const documents = await this.find(db, collection, filter, { limit: 1 });
    return documents[0] ?? null;
  }

  async updateOne(db, collection, filter, update, options = {}) {
    const entry = { q: filter, u: update };
    if (options.upsert) entry.upsert = true;
    return this.command({ update: collection, updates: [entry], $db: db });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
    this.fail(new Error("client is closed"));
  }
}
