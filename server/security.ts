import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Config } from "./config.js";
import type { Transport } from "./worker.js";

export function tokensEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export function verifySignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(nowMs / 1000 - Number(timestamp)) > 300
  )
    return false;
  if (!/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  return tokensEqual(signature, expected);
}

export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 6) {
    const lowered = address.toLowerCase();
    // Only global unicast; reject mapped IPv4, loopback, ULA, link local and documentation ranges.
    return (
      /^[23]/.test(lowered) &&
      !lowered.startsWith("2001:db8:") &&
      !lowered.startsWith("2001:0:") &&
      !lowered.startsWith("2002:")
    );
  }
  if (kind !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function validateTarget(
  raw: string,
  config: Pick<Config, "demoMode" | "port">,
): URL {
  if (raw.length > 2048) throw new Error("Endpoint URL is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid absolute HTTP or HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Use HTTP(S) without credentials or a fragment");
  }
  if (isDemoTarget(url, config)) return url;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (isIP(hostname) && !isPublicAddress(hostname))
  ) {
    throw new Error("Private and reserved network destinations are blocked");
  }
  return url;
}

function isDemoTarget(
  url: URL,
  config: Pick<Config, "demoMode" | "port">,
): boolean {
  return (
    config.demoMode &&
    url.origin === `http://127.0.0.1:${config.port}` &&
    /^\/api\/demo\/receiver\/(good|flaky|reject)$/.test(url.pathname) &&
    !url.search
  );
}

export function createTransport(
  config: Pick<Config, "demoMode" | "port">,
): Transport {
  return async ({ url: target, body, headers }) => {
    const url = validateTarget(target, config);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let pinned: { address: string; family: number };
    if (isDemoTarget(url, config)) pinned = { address: "127.0.0.1", family: 4 };
    else {
      let dnsTimer: ReturnType<typeof setTimeout> | undefined;
      const addresses = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          dnsTimer = setTimeout(
            () => reject(new Error("Destination DNS lookup timed out")),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(dnsTimer));
      if (
        !addresses.length ||
        addresses.some((item) => !isPublicAddress(item.address))
      ) {
        throw new Error(
          "Destination DNS resolves to a private or reserved address",
        );
      }
      pinned = addresses[0];
    }
    // Connect to the validated address, retaining the original Host header and TLS SNI.
    // A second DNS resolution here would allow DNS rebinding.
    return new Promise((resolve, reject) => {
      const requestOptions: http.RequestOptions & {
        autoSelectFamily: boolean;
      } = {
        method: "POST",
        agent: false,
        autoSelectFamily: false,
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        lookup: (_name, _options, callback) =>
          callback(null, pinned.address, pinned.family),
      };
      const request = (url.protocol === "https:" ? https : http).request(
        url,
        requestOptions,
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if (bytes < 4096) chunks.push(chunk.subarray(0, 4096 - bytes));
            bytes += chunk.length;
            if (bytes > 1024 * 1024)
              response.destroy(new Error("Receiver response exceeds 1 MiB"));
          });
          response.on("end", () =>
            resolve({
              statusCode: response.statusCode ?? 500,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", reject);
          response.on("aborted", () =>
            reject(new Error("Receiver aborted its response")),
          );
        },
      );
      const deadline = setTimeout(
        () => request.destroy(new Error("Receiver timed out after 10 seconds")),
        10000,
      );
      request.on("close", () => clearTimeout(deadline));
      request.on("error", reject);
      request.end(body);
    });
  };
}
