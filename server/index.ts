import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTransport } from "./security.js";
import { Store } from "./store.js";
import { startWorker } from "./runtime.js";

const config = loadConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });
const store = new Store(config.databasePath);
const app = await createApp(config, { store });
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  store.close();
  process.exit(1);
}
const stopWorker = config.workerEnabled
  ? startWorker(store, createTransport(config), {
      retryBaseMs: config.retryBaseMs,
      onError: (error) => app.log.error(error, "Worker iteration failed"),
    })
  : async () => {};
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopWorker();
  await app.close();
  store.close();
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
