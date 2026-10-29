import { tick, type Transport } from "./worker.js";
import type { Store } from "./store.js";

export function startWorker(
  store: Store,
  transport: Transport,
  options: { retryBaseMs: number; onError: (error: unknown) => void },
): () => Promise<void> {
  let running = true;
  let wake: (() => void) | undefined;
  const loop = (async () => {
    while (running) {
      let worked = false;
      try {
        worked = await tick(store, transport, {
          retryBaseMs: options.retryBaseMs,
        });
      } catch (error) {
        options.onError(error);
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, worked ? 0 : 250);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  })();
  return async () => {
    running = false;
    wake?.();
    await loop;
  };
}
