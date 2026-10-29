import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Store } from "../server/store.js";
import { tick, type Transport } from "../server/worker.js";

const stores: Store[] = [];
function fixture(maxAttempts = 5) {
  const store = new Store(":memory:");
  stores.push(store);
  const endpoint = store.createEndpoint({
    name: "Receiver",
    url: "https://example.com/webhook",
  });
  const accepted = store.submitEvent({
    type: "order.created",
    payload: { orderId: "order_42" },
    idempotencyKey: "order_42",
    maxAttempts,
  });
  return {
    store,
    endpoint,
    event: accepted.event,
    deliveryId: accepted.deliveries[0].id,
    nowMs: Date.now() + 1000,
  };
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

test("worker signs the exact transmitted bytes and keeps event identity stable", async () => {
  const { store, endpoint, event, deliveryId, nowMs } = fixture();
  const transport: Transport = async (input) => {
    assert.equal(input.url, endpoint.url);
    assert.equal(input.headers["webhook-id"], event.id);
    assert.equal(input.headers["webhook-delivery-id"], deliveryId);
    const signature = createHmac("sha256", endpoint.secret)
      .update(`${input.headers["webhook-timestamp"]}.${input.body}`)
      .digest("hex");
    assert.equal(input.headers["webhook-signature"], `v1=${signature}`);
    assert.deepEqual(JSON.parse(input.body), {
      id: event.id,
      type: "order.created",
      createdAt: event.createdAt,
      data: { orderId: "order_42" },
    });
    return { statusCode: 204, body: "" };
  };
  assert.equal(await tick(store, transport, { now: () => nowMs }), true);
  const detail = store.getDelivery(deliveryId)!;
  assert.equal(detail.delivery.status, "delivered");
  assert.equal(detail.attempts[0].statusCode, 204);
  assert.equal(detail.attempts[0].durationMs, 0);
  assert.equal(await tick(store, transport, { now: () => nowMs }), false);
});

test("transient errors retry with exponential full jitter and a durable due time", async () => {
  const { store, deliveryId, nowMs } = fixture();
  let clock = nowMs;
  const transport: Transport = async () => ({
    statusCode: 503,
    body: "temporarily unavailable",
  });
  const options = { now: () => clock, random: () => 0.5, retryBaseMs: 1000 };
  await tick(store, transport, options);
  let detail = store.getDelivery(deliveryId)!;
  assert.equal(detail.delivery.status, "retrying");
  assert.equal(Date.parse(detail.delivery.nextAttemptAt!) - clock, 500);
  clock += 499;
  assert.equal(await tick(store, transport, options), false);
  clock += 1;
  assert.equal(await tick(store, transport, options), true);
  detail = store.getDelivery(deliveryId)!;
  assert.equal(Date.parse(detail.delivery.nextAttemptAt!) - clock, 1000);
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.statusCode),
    [503, 503],
  );
  clock += 1000;
  await tick(
    store,
    async () => ({ statusCode: 200, body: "recovered" }),
    options,
  );
  detail = store.getDelivery(deliveryId)!;
  assert.equal(detail.delivery.status, "delivered");
  assert.equal(detail.delivery.attempts, 3);
  assert.equal(detail.delivery.nextAttemptAt, null);
});

for (const statusCode of [408, 425, 429, 500, 503]) {
  test(`HTTP ${statusCode} is transient`, async () => {
    const { store, deliveryId, nowMs } = fixture();
    await tick(store, async () => ({ statusCode, body: "" }), {
      now: () => nowMs,
    });
    assert.equal(store.getDelivery(deliveryId)!.delivery.status, "retrying");
  });
}

for (const statusCode of [301, 302, 400, 401, 404, 422, 600]) {
  test(`HTTP ${statusCode} is terminal, including redirects`, async () => {
    const { store, deliveryId, nowMs } = fixture();
    await tick(store, async () => ({ statusCode, body: "rejected" }), {
      now: () => nowMs,
    });
    assert.equal(store.getDelivery(deliveryId)!.delivery.status, "dead");
    assert.equal(store.getDelivery(deliveryId)!.delivery.nextAttemptAt, null);
  });
}

test("repeated transient failures reach the dead-letter queue at the configured budget", async () => {
  const { store, deliveryId, nowMs } = fixture(2);
  const transport: Transport = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const options = { now: () => nowMs, random: () => 0 };
  await tick(store, transport, options);
  assert.equal(store.getDelivery(deliveryId)!.delivery.status, "retrying");
  await tick(store, transport, options);
  const detail = store.getDelivery(deliveryId)!;
  assert.equal(detail.delivery.status, "dead");
  assert.equal(detail.delivery.attempts, 2);
  assert.equal(detail.attempts[0].error, "connect ECONNREFUSED");
  assert.equal(await tick(store, transport, options), false);
});

test("response storage and network error messages are bounded and signing secrets redacted", async () => {
  const { store, deliveryId, endpoint, nowMs } = fixture();
  await tick(
    store,
    async () => {
      throw new Error(`bad\n${endpoint.secret}\r${"x".repeat(1000)}`);
    },
    { now: () => nowMs, random: () => 0 },
  );
  let detail = store.getDelivery(deliveryId)!;
  assert.equal(detail.delivery.lastError!.includes(endpoint.secret), false);
  assert.equal(detail.delivery.lastError!.includes("\n"), false);
  assert.equal(detail.delivery.lastError!.length, 500);
  await tick(
    store,
    async () => ({ statusCode: 200, body: "a".repeat(20_000) }),
    { now: () => nowMs },
  );
  detail = store.getDelivery(deliveryId)!;
  assert.equal(Buffer.byteLength(detail.attempts[0].responseBody!), 4096);
});

test("a blocked transport never holds a database transaction or lets another worker claim it", async () => {
  const { store, nowMs, deliveryId } = fixture();
  let finish!: (value: { statusCode: number; body: string }) => void;
  const pending = tick(
    store,
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { now: () => nowMs },
  );
  assert.equal(store.getDelivery(deliveryId)!.delivery.status, "processing");
  assert.equal(store.claimDelivery(nowMs + 1, 30_000), undefined);
  assert.doesNotThrow(() =>
    store.createEndpoint({
      name: "Independent write",
      url: "https://example.com/other",
    }),
  );
  finish({ statusCode: 200, body: "ok" });
  await pending;
  assert.equal(store.getDelivery(deliveryId)!.delivery.status, "delivered");
});

test("late success from a stale worker cannot overwrite a recovered delivery", async () => {
  const { store, deliveryId, nowMs } = fixture();
  let clock = nowMs;
  let finish!: (value: { statusCode: number; body: string }) => void;
  const first = tick(
    store,
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { now: () => clock, leaseMs: 100 },
  );
  clock += 101;
  await tick(store, async () => ({ statusCode: 404, body: "missing" }), {
    now: () => clock,
    leaseMs: 100,
  });
  finish({ statusCode: 200, body: "late success" });
  await first;
  const detail = store.getDelivery(deliveryId)!;
  assert.equal(detail.delivery.status, "dead");
  assert.equal(detail.delivery.lastStatusCode, 404);
  assert.equal(detail.attempts[0].statusCode, 404);
  assert.match(detail.attempts[1].error!, /lease expired/);
});
