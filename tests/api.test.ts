import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { tick } from "../server/worker.js";
import { createTransport } from "../server/security.js";
import type { Config } from "../server/config.js";

const token = "test-api-token-1234567890-abcdefghijklmnop";
const auth = { authorization: `Bearer ${token}` };
const config: Config = {
  host: "127.0.0.1",
  port: 3000,
  databasePath: ":memory:",
  apiToken: token,
  demoMode: false,
  workerEnabled: false,
  retryBaseMs: 1000,
};

async function fixture(demoMode = false) {
  const store = new Store(":memory:");
  const app = await createApp(
    { ...config, demoMode },
    { store, logger: false, serveStatic: false },
  );
  return {
    store,
    app,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}

test("API requires auth, exposes only safe public configuration, and hides internals", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject("/api/health")).statusCode, 200);
    assert.deepEqual((await f.app.inject("/api/config")).json(), {
      demoMode: false,
    });
    assert.equal(
      (await f.app.inject("/api/openapi.json")).json().openapi,
      "3.0.3",
    );
    assert.equal((await f.app.inject("/api/docs")).statusCode, 200);
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { authorization: token },
    ]) {
      const response = await f.app.inject({ url: "/api/endpoints", headers });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, "UNAUTHORIZED");
      assert.equal(response.body.includes(token), false);
    }
    for (const url of [
      "/%61pi/endpoints",
      "/api/%65ndpoints",
      "/%61pi/stats",
      "/%61pi/audit",
    ]) {
      const response = await f.app.inject(url);
      assert.equal(response.statusCode, 401, url);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/%61pi/events",
          payload: { type: "x", payload: {} },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/demo/bootstrap",
          headers: auth,
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("API endpoint validation and event acceptance preserve idempotency and secret boundaries", async () => {
  const f = await fixture();
  try {
    const invalid = await f.app.inject({
      method: "POST",
      url: "/api/endpoints",
      headers: auth,
      payload: {
        name: "Metadata",
        url: "http://169.254.169.254/latest/meta-data",
      },
    });
    assert.equal(invalid.statusCode, 400);
    const created = await f.app.inject({
      method: "POST",
      url: "/api/endpoints",
      headers: auth,
      payload: { name: "Orders", url: "https://example.com/hooks" },
    });
    assert.equal(created.statusCode, 201);
    const endpoint = created.json();
    assert.match(endpoint.secret, /^whsec_/);
    const listing = await f.app.inject({
      url: "/api/endpoints",
      headers: auth,
    });
    assert.equal(listing.body.includes(endpoint.secret), false);
    const payload = {
      type: "order.created",
      payload: { order: 42 },
      endpointIds: [endpoint.id],
    };
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/events",
          headers: auth,
          payload,
        })
      ).statusCode,
      400,
    );
    const first = await f.app.inject({
      method: "POST",
      url: "/api/events",
      headers: { ...auth, "idempotency-key": "order-42" },
      payload,
    });
    assert.equal(first.statusCode, 201);
    const again = await f.app.inject({
      method: "POST",
      url: "/api/events",
      headers: { ...auth, "idempotency-key": "order-42" },
      payload,
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().event.id, first.json().event.id);
    const conflict = await f.app.inject({
      method: "POST",
      url: "/api/events",
      headers: { ...auth, "idempotency-key": "order-42" },
      payload: { ...payload, payload: { order: 43 } },
    });
    assert.equal(conflict.statusCode, 409);
    const deliveryId = first.json().deliveries[0].id;
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/deliveries/${deliveryId}/retry`,
          headers: auth,
        })
      ).statusCode,
      409,
    );
    const detail = await f.app.inject({
      url: `/api/deliveries/${deliveryId}`,
      headers: auth,
    });
    assert.equal(detail.json().event.payload.order, 42);
    assert.equal(detail.body.includes(endpoint.secret), false);
    assert.equal(
      (await f.app.inject({ url: "/api/stats", headers: auth })).json().total,
      1,
    );
    assert.ok(
      (await f.app.inject({ url: "/api/audit", headers: auth })).json().items
        .length >= 2,
    );
  } finally {
    await f.close();
  }
});

test("API rejects malformed JSON, unexpected input types, invalid filters and disabled targets", async () => {
  const f = await fixture();
  try {
    const badJson = await f.app.inject({
      method: "POST",
      url: "/api/endpoints",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{no",
    });
    assert.equal(badJson.statusCode, 400);
    for (const payload of [
      { name: " ", url: "https://example.com" },
      { name: 42, url: "https://example.com" },
      { name: "x", url: "https://example.com", secret: "injected" },
    ])
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/endpoints",
            headers: auth,
            payload,
          })
        ).statusCode,
        400,
      );
    for (const query of [
      "limit=0",
      "offset=-1",
      "status=whatever",
      "limit=1.1",
      "eventId=a&eventId=b",
    ])
      assert.equal(
        (await f.app.inject({ url: `/api/deliveries?${query}`, headers: auth }))
          .statusCode,
        400,
      );
    const endpoint = f.store.createEndpoint({
      name: "Disabled",
      url: "https://example.com",
    });
    assert.equal(
      (
        await f.app.inject({
          method: "PATCH",
          url: `/api/endpoints/${endpoint.id}`,
          headers: auth,
          payload: { enabled: false },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/events",
          headers: { ...auth, "idempotency-key": "disabled-1" },
          payload: { type: "test", payload: {} },
        })
      ).statusCode,
      400,
    );
    assert.equal(f.store.listEvents().length, 0);
  } finally {
    await f.close();
  }
});

test("real HTTP demo exercises HMAC, retries, permanent rejection and manual replay", async () => {
  const store = new Store(":memory:");
  const localConfig = { ...config, demoMode: true, port: 0 };
  const app = await createApp(localConfig, {
    store,
    logger: false,
    serveStatic: false,
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    localConfig.port = address.port;
    const seeded = await app.inject({
      method: "POST",
      url: "/api/demo/bootstrap",
      headers: auth,
    });
    assert.equal(seeded.statusCode, 201);
    assert.equal(seeded.json().deliveries.length, 3);
    assert.equal(seeded.body.includes("whsec_"), false);
    const unsigned = await app.inject({
      method: "POST",
      url: "/api/demo/receiver/good",
      payload: {},
    });
    assert.equal(unsigned.statusCode, 401);
    const transport = createTransport(localConfig);
    for (let i = 0; i < 8; i++)
      await tick(store, transport, { random: () => 0 });
    const items = store.listDeliveries().items;
    assert.equal(items.filter((item) => item.status === "delivered").length, 2);
    assert.equal(items.filter((item) => item.status === "dead").length, 1);
    const flaky = items.find((item) => item.endpointUrl.endsWith("/flaky"))!;
    assert.equal(flaky.attempts, 3);
    assert.deepEqual(
      [...store.getDelivery(flaky.id)!.attempts]
        .sort((a, b) => a.number - b.number)
        .map((item) => item.statusCode),
      [503, 503, 200],
    );
    const rejected = items.find((item) => item.status === "dead")!;
    assert.equal(rejected.attempts, 1);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/deliveries/${rejected.id}/retry`,
          headers: auth,
        })
      ).statusCode,
      200,
    );
    await tick(store, transport);
    assert.equal(store.getDelivery(rejected.id)!.attempts.length, 2);
  } finally {
    await app.close();
    store.close();
  }
});
