import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { createTransport } from "../server/security.js";

async function receiver(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("real transport posts exact Unicode bytes with correct length and preserves webhook headers", async () => {
  const body = JSON.stringify({ message: "订单已支付 🧾" });
  let received = "";
  let contentLength = "";
  let signature = "";
  const local = await receiver((request, response) => {
    contentLength = request.headers["content-length"] ?? "";
    signature = String(request.headers["webhook-signature"]);
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"accepted":true}');
    });
  });
  try {
    const result = await createTransport({ demoMode: true, port: local.port })({
      url: `http://127.0.0.1:${local.port}/api/demo/receiver/good`,
      body,
      headers: { "webhook-signature": "v1=test-value" },
    });
    assert.equal(received, body);
    assert.equal(Number(contentLength), Buffer.byteLength(body));
    assert.equal(signature, "v1=test-value");
    assert.equal(result.statusCode, 202);
  } finally {
    await local.close();
  }
});

test("a redirect response never causes transport to follow a private Location", async () => {
  const paths: string[] = [];
  const local = await receiver((request, response) => {
    paths.push(request.url!);
    response.writeHead(302, { location: "/private/admin" });
    response.end("moved");
  });
  try {
    const result = await createTransport({ demoMode: true, port: local.port })({
      url: `http://127.0.0.1:${local.port}/api/demo/receiver/good`,
      body: "{}",
      headers: {},
    });
    assert.equal(result.statusCode, 302);
    assert.equal(result.body, "moved");
    assert.deepEqual(paths, ["/api/demo/receiver/good"]);
  } finally {
    await local.close();
  }
});

test("receiver response capture is bounded and an oversized stream is terminated", async () => {
  let oversized = false;
  const local = await receiver((_request, response) => {
    response.writeHead(200);
    response.end(Buffer.alloc(oversized ? 2 * 1024 * 1024 : 20000, 97));
  });
  try {
    const transport = createTransport({ demoMode: true, port: local.port });
    const input = {
      url: `http://127.0.0.1:${local.port}/api/demo/receiver/good`,
      body: "{}",
      headers: {},
    };
    const first = await transport(input);
    assert.equal(Buffer.byteLength(first.body), 4096);
    assert.equal(first.body, "a".repeat(4096));
    oversized = true;
    await assert.rejects(transport(input), /response|aborted/i);
  } finally {
    await local.close();
  }
});

test("DNS hostnames resolving wholly or partly to private networks are blocked before HTTP", async (t) => {
  let connected = false;
  const local = await receiver((_request, response) => {
    connected = true;
    response.end("should not be reached");
  });
  const mocked = t.mock.method(dns, "lookup", async (hostname: string) =>
    hostname === "mixed.example.test"
      ? [
          { address: "1.1.1.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]
      : [{ address: "127.0.0.1", family: 4 }],
  );
  syncBuiltinESMExports();
  try {
    const transport = createTransport({ demoMode: false, port: local.port });
    for (const hostname of ["private.example.test", "mixed.example.test"]) {
      await assert.rejects(
        transport({
          url: `http://${hostname}:${local.port}/hook`,
          body: "{}",
          headers: {},
        }),
        /private or reserved/,
      );
    }
    assert.equal(mocked.mock.callCount(), 2);
    assert.equal(connected, false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await local.close();
  }
});

test("connection lookup pins validated DNS address and cannot perform DNS rebinding", async (t) => {
  const dnsLookup = t.mock.method(dns, "lookup", async () => [
    { address: "1.1.1.1", family: 4 },
  ]);
  const requestMock = t.mock.method(
    http,
    "request",
    (
      _url: URL,
      options: http.RequestOptions,
      responseCallback: (response: http.IncomingMessage) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error?: Error) => void;
      };
      request.destroy = (error) => {
        if (error) request.emit("error", error);
        request.emit("close");
      };
      request.end = () => {
        queueMicrotask(() => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
          };
          response.statusCode = 200;
          responseCallback(response as http.IncomingMessage);
          response.emit("data", Buffer.from("ok"));
          response.emit("end");
          request.emit("close");
        });
      };
      return request as unknown as http.ClientRequest;
    },
  );
  syncBuiltinESMExports();
  try {
    const transport = createTransport({ demoMode: false, port: 3000 });
    assert.equal(
      (
        await transport({
          url: "http://webhook.example.test/hook",
          body: "{}",
          headers: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(dnsLookup.mock.callCount(), 1);
    const options = requestMock.mock.calls[0]
      .arguments[1] as http.RequestOptions;
    assert.equal(
      options.autoSelectFamily,
      false,
      "Node must request a single address from the pinned lookup callback",
    );
    let connectedAddress: string | undefined;
    let connectedFamily: number | undefined;
    const pinnedLookup = options.lookup as (
      hostname: string,
      options: object,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    pinnedLookup("webhook.example.test", {}, (error, address, family) => {
      assert.equal(error, null);
      connectedAddress = address;
      connectedFamily = family;
    });
    assert.equal(connectedAddress, "1.1.1.1");
    assert.equal(connectedFamily, 4);
    assert.equal(
      dnsLookup.mock.callCount(),
      1,
      "The socket lookup must never resolve the hostname a second time",
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
