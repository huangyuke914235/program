import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  isPublicAddress,
  tokensEqual,
  validateTarget,
  verifySignature,
  createTransport,
} from "../server/security.js";
import { loadConfig } from "../server/config.js";

test("signature verification uses raw bytes, checks timestamp and rejects tampering", () => {
  const body = '{"id":"evt-1","data":{"amount":42}}';
  const now = 1700000000000,
    timestamp = String(now / 1000),
    secret = "whsec_test";
  const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  assert.equal(verifySignature(body, timestamp, signature, secret, now), true);
  assert.equal(
    verifySignature(body + " ", timestamp, signature, secret, now),
    false,
  );
  assert.equal(
    verifySignature(body, timestamp, signature, secret, now + 301000),
    false,
  );
  assert.equal(
    verifySignature(body, timestamp, signature, secret, now - 301000),
    false,
  );
  assert.equal(
    verifySignature(body, timestamp, "v1=nothex", secret, now),
    false,
  );
  assert.equal(
    verifySignature(body, "Infinity", signature, secret, now),
    false,
  );
  assert.equal(tokensEqual("correct", "correct"), true);
  assert.equal(tokensEqual("", "correct"), false);
});

test("SSRF policy rejects private, reserved and mapped addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.31.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "100.64.1.1",
    "192.0.0.1",
    "198.18.0.1",
    "198.51.100.3",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    assert.equal(isPublicAddress(address), true, address);
});

test("URL policy handles unusual loopback encodings and only permits exact demo targets", () => {
  const config = { demoMode: false, port: 3000 };
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com",
    "http://user:pass@example.com",
    "https://example.com/#token",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://[::1]",
    "http://localhost",
    "http://test.localhost",
  ])
    assert.throws(() => validateTarget(url, config), undefined, url);
  assert.equal(
    validateTarget("https://example.com/hooks", config).hostname,
    "example.com",
  );
  assert.equal(
    validateTarget("http://127.0.0.1:3000/api/demo/receiver/good", {
      ...config,
      demoMode: true,
    }).pathname,
    "/api/demo/receiver/good",
  );
  for (const url of [
    "http://127.0.0.1:3001/api/demo/receiver/good",
    "http://127.0.0.1:3000/api/health",
    "http://127.0.0.1:3000/api/demo/receiver/good?x=1",
  ])
    assert.throws(() => validateTarget(url, { ...config, demoMode: true }));
});

test("transport refuses private literal destinations before connecting", async () => {
  const transport = createTransport({ demoMode: false, port: 3000 });
  await assert.rejects(
    transport({
      url: "http://169.254.169.254/latest/meta-data",
      body: "{}",
      headers: {},
    }),
    /blocked/,
  );
});

test("configuration fails closed for missing secrets and invalid settings", () => {
  assert.throws(() => loadConfig({}), /API_TOKEN/);
  assert.throws(
    () =>
      loadConfig({ API_TOKEN: "replace-me-with-a-random-token-long-enough" }),
    /API_TOKEN/,
  );
  assert.throws(
    () => loadConfig({ API_TOKEN: "x".repeat(40), PORT: "-1" }),
    /numeric/,
  );
  assert.throws(
    () => loadConfig({ API_TOKEN: "x".repeat(40), DEMO_MODE: "yes" }),
    /Boolean/,
  );
  assert.equal(loadConfig({ API_TOKEN: "x".repeat(40) }).demoMode, false);
});
