import { createHmac } from "node:crypto";
import type { Store } from "./store.js";

export type Transport = (input: {
  url: string;
  body: string;
  headers: Record<string, string>;
}) => Promise<{ statusCode: number; body: string }>;

export interface WorkerOptions {
  now?: () => number;
  random?: () => number;
  retryBaseMs?: number;
  leaseMs?: number;
}

function clean(message: string, secret: string): string {
  return message
    .replaceAll(secret, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 500);
}

/** Claims a single delivery, performs HTTP outside the transaction, then commits using its lease token. */
export async function tick(
  store: Store,
  transport: Transport,
  options: WorkerOptions = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const claim = store.claimDelivery(now(), options.leaseMs ?? 30_000);
  if (!claim) return false;
  const body = JSON.stringify({
    id: claim.event.id,
    type: claim.event.type,
    createdAt: claim.event.createdAt,
    data: claim.event.payload,
  });
  const timestamp = String(Math.floor(now() / 1000));
  const signature = createHmac("sha256", claim.secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  let retryable = true;
  let success = false;
  try {
    const response = await transport({
      url: claim.delivery.endpointUrl,
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "RelayForge/1.0",
        "webhook-id": claim.event.id,
        "webhook-delivery-id": claim.delivery.id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1=${signature}`,
      },
    });
    statusCode = response.statusCode;
    responseBody = Buffer.from(response.body)
      .subarray(0, 4096)
      .toString("utf8");
    success = statusCode >= 200 && statusCode < 300;
    retryable =
      statusCode === 408 ||
      statusCode === 425 ||
      statusCode === 429 ||
      (statusCode >= 500 && statusCode < 600);
    if (!success) error = `HTTP ${statusCode}`;
  } catch (caught) {
    error = clean(
      caught instanceof Error ? caught.message : "Network request failed.",
      claim.secret,
    );
  }
  const ceiling = Math.min(
    60_000,
    (options.retryBaseMs ?? 1000) *
      2 ** Math.max(0, claim.delivery.attempts - 1),
  );
  const jitter = Math.min(1, Math.max(0, (options.random ?? Math.random)()));
  const retryDelayMs = Math.floor(jitter * ceiling);
  store.completeDelivery(claim, {
    nowMs: now(),
    statusCode,
    responseBody,
    error,
    success,
    retryable,
    retryDelayMs,
  });
  return true;
}
