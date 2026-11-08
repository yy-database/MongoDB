// Long-running REST service. Point it at a running product server with
// `MONGO_URL`, or at any MongoDB-compatible endpoint that supports the same
// commands. SIGINT/SIGTERM close the HTTP server before the driver.
import { MongoClient } from "mongodb";

import { createApp } from "./app.mjs";

const url = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/?directConnection=true";
const dbName = process.env.MONGO_DB ?? "shop";
const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}

const client = new MongoClient(url, { maxPoolSize: 10, retryWrites: false });
await client.connect();
const app = await createApp({ client, dbName });

const httpServer = app.listen(port, () => {
  const address = httpServer.address();
  console.log(`mongo-products listening on http://127.0.0.1:${address.port} (db=${dbName})`);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);
  await new Promise((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await client.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
}
