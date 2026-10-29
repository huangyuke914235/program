import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Store, type DeliveryOutcome } from "../server/store.js";

const stores: Store[] = [];
const directories: string[] = [];
function memory(): Store {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
}
function fixture(store = memory(), maxAttempts = 5) {
  const endpoint = store.createEndpoint({
    name: "Billing service",
    url: "https://example.com/webhooks",
  });
  const accepted = store.submitEvent({
    type: "invoice.paid",
    payload: { amount: 2400 },
    idempotencyKey: "invoice-1",
    maxAttempts,
  });
  return { store, endpoint, ...accepted, now: Date.now() + 1000 };
}
function outcome(
  nowMs: number,
  overrides: Partial<DeliveryOutcome> = {},
): DeliveryOutcome {
  return {
    nowMs,
    statusCode: 200,
    responseBody: "ok",
    error: null,
    success: true,
    retryable: false,
    retryDelayMs: 0,
    ...overrides,
  };
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length)
    rmSync(directories.pop()!, { recursive: true, force: true });
});

test("event and all delivery jobs commit atomically; a failed insert leaves no event", () => {
  const store = memory();
  store.createEndpoint({ name: "Receiver", url: "https://example.com/hook" });
  store.db.exec(
    "CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'simulated disk write failure'); END;",
  );
  assert.throws(
    () =>
      store.submitEvent({
        type: "test",
        payload: {},
        idempotencyKey: "atomic",
      }),
    /simulated disk write failure/,
  );
  assert.equal(store.listEvents().length, 0);
  assert.equal(store.listDeliveries().total, 0);
  assert.equal(
    store.audit().some((entry) => entry.action === "event.accepted"),
    false,
  );
  store.db.exec("DROP TRIGGER reject_delivery");
  assert.equal(
    store.submitEvent({ type: "test", payload: {}, idempotencyKey: "atomic" })
      .duplicate,
    false,
  );
});

test("idempotent replay ignores JSON object and explicit target ordering", () => {
  const store = memory();
  const a = store.createEndpoint({ name: "A", url: "https://example.com/a" });
  const b = store.createEndpoint({ name: "B", url: "https://example.com/b" });
  const first = store.submitEvent({
    type: "order.created",
    payload: { a: 1, nested: { b: 2, a: 3 }, list: [{ z: 4, a: 1 }] },
    endpointIds: [a.id, b.id],
    idempotencyKey: "same",
  });
  const second = store.submitEvent({
    type: "order.created",
    payload: { list: [{ a: 1, z: 4 }], nested: { a: 3, b: 2 }, a: 1 },
    endpointIds: [b.id, a.id],
    idempotencyKey: "same",
  });
  assert.equal(second.duplicate, true);
  assert.equal(first.event.id, second.event.id);
  assert.equal(store.listDeliveries().total, 2);
});

test("idempotency protects changed payloads and event types", () => {
  const { store } = fixture();
  assert.throws(
    () =>
      store.submitEvent({
        type: "invoice.paid",
        payload: { amount: 999 },
        idempotencyKey: "invoice-1",
      }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.throws(
    () =>
      store.submitEvent({
        type: "invoice.refunded",
        payload: { amount: 2400 },
        idempotencyKey: "invoice-1",
      }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.equal(store.listEvents().length, 1);
});

test("replaying an all-targets request does not add newly registered endpoints", () => {
  const { store, event: first } = fixture();
  store.createEndpoint({ name: "New service", url: "https://example.com/new" });
  const replay = store.submitEvent({
    type: "invoice.paid",
    payload: { amount: 2400 },
    idempotencyKey: "invoice-1",
  });
  assert.equal(replay.event.id, first.id);
  assert.equal(replay.deliveries.length, 1);
});

test("invalid target sets create neither event nor jobs", () => {
  const store = memory();
  const endpoint = store.createEndpoint({
    name: "Disabled",
    url: "https://example.com/hook",
  });
  store.setEndpointEnabled(endpoint.id, false);
  for (const endpointIds of [undefined, [], ["missing"], [endpoint.id]]) {
    assert.throws(
      () =>
        store.submitEvent({
          type: "test",
          payload: {},
          endpointIds,
          idempotencyKey: "invalid",
        }),
      { code: "INVALID_ENDPOINTS" },
    );
  }
  assert.equal(store.listEvents().length, 0);
});

test("signing secrets are returned at creation and excluded from public records and audit", () => {
  const { store, endpoint } = fixture();
  assert.match(endpoint.secret, /^whsec_/);
  assert.equal(store.getEndpointSecret(endpoint.id), endpoint.secret);
  assert.equal(
    JSON.stringify(store.listEndpoints()).includes(endpoint.secret),
    false,
  );
  assert.equal(JSON.stringify(store.audit()).includes(endpoint.secret), false);
});

test("paused endpoints retain queued jobs without being claimed, then resume", () => {
  const { store, endpoint, now } = fixture();
  store.setEndpointEnabled(endpoint.id, false);
  assert.equal(store.claimDelivery(now, 30_000), undefined);
  assert.equal(store.listDeliveries().items[0].status, "pending");
  store.setEndpointEnabled(endpoint.id, true);
  assert.ok(store.claimDelivery(now, 30_000));
});

test("independent SQLite connections cannot claim the same live delivery", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-concurrency-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const one = new Store(path);
  const two = new Store(path);
  stores.push(one, two);
  const { now, deliveries } = fixture(one);
  const claimed = one.claimDelivery(now, 30_000);
  assert.equal(claimed?.delivery.id, deliveries[0].id);
  assert.equal(two.claimDelivery(now + 1, 30_000), undefined);
  assert.equal(two.getDelivery(deliveries[0].id)?.attempts.length, 1);
  assert.equal(
    (two.db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>)
      .journal_mode,
    "wal",
  );
});

test(
  "two real worker processes racing for one job produce exactly one claim",
  { timeout: 10_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayforge-process-race-"));
    directories.push(directory);
    const path = join(directory, "test.sqlite");
    const store = new Store(path);
    stores.push(store);
    const { now, deliveries } = fixture(store);
    const storeUrl = new URL("../server/store.ts", import.meta.url).href;
    const script = `
    import { Store } from ${JSON.stringify(storeUrl)};
    const store = new Store(${JSON.stringify(path)});
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      const claim = store.claimDelivery(${now}, 30000);
      process.stdout.write(JSON.stringify(claim?.delivery.id ?? null) + '\\n');
      store.close();
      process.stdin.destroy();
    });
  `;
    const processes: ChildProcessWithoutNullStreams[] = [];
    function start() {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          stdio: "pipe",
          windowsHide: true,
        },
      );
      processes.push(child);
      const ready = new Promise<void>((resolve, reject) => {
        let buffered = "";
        child.stdout.on("data", (chunk) => {
          buffered += String(chunk);
          if (buffered.includes("ready\n")) resolve();
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (!buffered.includes("ready\n"))
            reject(new Error(`Worker exited before ready: ${code}`));
        });
      });
      return { child, ready };
    }
    try {
      const workers = [start(), start()];
      await Promise.all(workers.map((worker) => worker.ready));
      const claimed = workers.map(({ child }) =>
        once(child.stdout, "data").then(
          ([chunk]) => JSON.parse(String(chunk).trim()) as string | null,
        ),
      );
      const exits = workers.map(({ child }) => once(child, "exit"));
      for (const { child } of workers) child.stdin.write("claim");
      const results = await Promise.all(claimed);
      await Promise.all(exits);
      assert.deepEqual(results.filter(Boolean), [deliveries[0].id]);
      assert.equal(store.getDelivery(deliveries[0].id)!.attempts.length, 1);
    } finally {
      for (const child of processes) if (child.exitCode === null) child.kill();
    }
  },
);

test("expired leases are recovered and fenced against the previous worker", () => {
  const { store, now, deliveries } = fixture();
  const first = store.claimDelivery(now, 100)!;
  assert.equal(
    store.completeDelivery(first, outcome(now + 100)),
    false,
    "expired token cannot complete before recovery either",
  );
  const second = store.claimDelivery(now + 101, 100)!;
  assert.notEqual(first.token, second.token);
  assert.equal(store.completeDelivery(first, outcome(now + 102)), false);
  assert.equal(store.completeDelivery(second, outcome(now + 103)), true);
  const detail = store.getDelivery(deliveries[0].id)!;
  assert.equal(detail.delivery.status, "delivered");
  assert.equal(detail.delivery.attempts, 2);
  assert.match(detail.attempts[1].error!, /lease expired/);
  assert.equal(detail.attempts[0].statusCode, 200);
});

test("crashes cannot bypass maxAttempts when leases expire", () => {
  const { store, now, deliveries } = fixture(undefined, 1);
  assert.ok(store.claimDelivery(now, 100));
  assert.equal(store.claimDelivery(now + 101, 100), undefined);
  const detail = store.getDelivery(deliveries[0].id)!;
  assert.equal(detail.delivery.status, "dead");
  assert.equal(detail.delivery.attempts, 1);
  assert.equal(detail.attempts.length, 1);
  assert.ok(detail.attempts[0].finishedAt);
});

test("manual replay resets the budget while preserving monotonically numbered history", () => {
  const { store, now, deliveries } = fixture();
  const first = store.claimDelivery(now, 30_000)!;
  assert.throws(() => store.retryDelivery(deliveries[0].id), {
    code: "DELIVERY_BUSY",
  });
  store.completeDelivery(first, outcome(now + 1));
  const retried = store.retryDelivery(deliveries[0].id)!;
  assert.equal(retried.attempts, 0);
  assert.equal(retried.status, "pending");
  const second = store.claimDelivery(now + 2, 30_000)!;
  store.completeDelivery(second, outcome(now + 3));
  const detail = store.getDelivery(deliveries[0].id)!;
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.number),
    [2, 1],
  );
  assert.equal(detail.delivery.attempts, 1);
  assert.equal(
    store.audit().filter((entry) => entry.action === "delivery.replayed")
      .length,
    1,
  );
});

test("durable queue and endpoint signing secrets survive a database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-reopen-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const one = new Store(path);
  const initial = fixture(one);
  one.close();
  const two = new Store(path);
  stores.push(two);
  assert.equal(
    two.getEndpointSecret(initial.endpoint.id),
    initial.endpoint.secret,
  );
  assert.equal(two.listDeliveries().total, 1);
  assert.equal(two.getEvent(initial.event.id)?.payload.amount, 2400);
  assert.ok(two.claimDelivery(initial.now, 30_000));
});

test("stats include 24 hourly bins and reconcile delivery states", () => {
  const { store, now, deliveries } = fixture();
  assert.equal(store.stats().pending, 1);
  const claim = store.claimDelivery(now, 30_000)!;
  store.completeDelivery(claim, outcome(now + 1));
  const stats = store.stats();
  assert.equal(stats.delivered, 1);
  assert.equal(stats.successRate, 100);
  assert.equal(stats.activity.length, 24);
  assert.equal(
    stats.activity.reduce((sum, bin) => sum + bin.delivered, 0),
    1,
  );
  assert.equal(
    store.listDeliveries({
      status: "delivered",
      eventId: deliveries[0].eventId,
    }).total,
    1,
  );
  assert.equal(store.listDeliveries({ offset: 1 }).items.length, 0);
});
