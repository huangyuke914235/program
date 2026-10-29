import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { createTransport } from "./security.js";
import { Store } from "./store.js";
import { startWorker } from "./runtime.js";

const config = loadConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });
const store = new Store(config.databasePath);
const stop = startWorker(store, createTransport(config), {
  retryBaseMs: config.retryBaseMs,
  onError: (error) => console.error("Worker iteration failed", error),
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stop();
  store.close();
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
