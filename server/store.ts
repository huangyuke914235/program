import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Attempt,
  AuditEntry,
  DashboardStats,
  Delivery,
  DeliveryStatus,
  Endpoint,
  EventRecord,
} from "./types.js";

type Row = Record<string, unknown>;
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const iso = (value = Date.now()) => new Date(value).toISOString();
const endpointFields = "id, name, url, enabled, createdAt";
const deliveryFields = `d.id, d.eventId, d.endpointId, ev.type AS eventType,
  ep.name AS endpointName, d.endpointUrl, d.status, d.attempts, d.maxAttempts,
  d.nextAttemptAt, d.lastStatusCode, d.lastError, d.createdAt, d.updatedAt`;
const deliveryJoin =
  "FROM deliveries d JOIN events ev ON ev.id = d.eventId JOIN endpoints ep ON ep.id = d.endpointId";

function endpoint(row: Row): Endpoint {
  return {
    id: row.id as string,
    name: row.name as string,
    url: row.url as string,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt as string,
  };
}

function event(row: Row): EventRecord {
  return {
    id: row.id as string,
    type: row.type as string,
    payload: JSON.parse(row.payload as string) as Record<string, unknown>,
    createdAt: row.createdAt as string,
    idempotencyKey: row.idempotencyKey as string,
  };
}

/** Sort object keys recursively so equivalent JSON objects share a request fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function domainError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export interface DeliveryClaim {
  delivery: Delivery;
  event: EventRecord;
  secret: string;
  token: string;
  attemptId: string;
  startedAt: number;
}

export interface DeliveryOutcome {
  nowMs: number;
  statusCode: number | null;
  responseBody: string | null;
  error: string | null;
  success: boolean;
  retryable: boolean;
  retryDelayMs: number;
}

/** One synchronous connection per process. No transaction spans a network await. */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
    const version = (this.db.prepare("PRAGMA user_version").get() as Row)
      .user_version as number;
    if (version > 1) {
      this.db.close();
      throw new Error(
        `Database schema ${version} is newer than this application supports.`,
      );
    }
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS endpoints (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          secret TEXT NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
          idempotencyKey TEXT NOT NULL UNIQUE, requestHash TEXT NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deliveries (
          id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id),
          endpointId TEXT NOT NULL REFERENCES endpoints(id), endpointUrl TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','processing','retrying','delivered','dead')),
          attempts INTEGER NOT NULL DEFAULT 0, maxAttempts INTEGER NOT NULL,
          nextAttemptAt TEXT, lastStatusCode INTEGER, lastError TEXT,
          leaseToken TEXT, leaseExpiresAt TEXT, activeAttemptId TEXT,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          UNIQUE(eventId, endpointId)
        );
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, deliveryId TEXT NOT NULL REFERENCES deliveries(id),
          number INTEGER NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT,
          statusCode INTEGER, durationMs INTEGER, error TEXT, responseBody TEXT,
          UNIQUE(deliveryId, number)
        );
        CREATE TABLE IF NOT EXISTS audit (
          id TEXT PRIMARY KEY, action TEXT NOT NULL, resourceId TEXT NOT NULL,
          createdAt TEXT NOT NULL, detail TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, nextAttemptAt);
        CREATE INDEX IF NOT EXISTS deliveries_leases ON deliveries(status, leaseExpiresAt);
        CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(eventId);
        CREATE INDEX IF NOT EXISTS attempts_delivery ON attempts(deliveryId, number);
        PRAGMA user_version = 1;
      `);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private record(
    action: string,
    resourceId: string,
    detail: string,
    timestamp = iso(),
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit (id,action,resourceId,createdAt,detail) VALUES (?,?,?,?,?)",
      )
      .run(id("aud"), action, resourceId, timestamp, detail);
  }

  close(): void {
    this.db.close();
  }

  listEndpoints(): Endpoint[] {
    return (
      this.db
        .prepare(
          `SELECT ${endpointFields} FROM endpoints ORDER BY createdAt DESC, id`,
        )
        .all() as Row[]
    ).map(endpoint);
  }

  createEndpoint(input: {
    name: string;
    url: string;
  }): Endpoint & { secret: string } {
    return this.transaction(() => {
      const result = {
        id: id("ep"),
        ...input,
        enabled: true,
        createdAt: iso(),
        secret: `whsec_${randomBytes(32).toString("base64url")}`,
      };
      this.db
        .prepare(
          "INSERT INTO endpoints (id,name,url,enabled,secret,createdAt) VALUES (?,?,?,1,?,?)",
        )
        .run(
          result.id,
          result.name,
          result.url,
          result.secret,
          result.createdAt,
        );
      this.record("endpoint.created", result.id, result.name, result.createdAt);
      return result;
    });
  }

  setEndpointEnabled(
    endpointId: string,
    enabled: boolean,
  ): Endpoint | undefined {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE endpoints SET enabled = ? WHERE id = ? RETURNING ${endpointFields}`,
        )
        .get(Number(enabled), endpointId) as Row | undefined;
      if (!result) return undefined;
      this.record(
        enabled ? "endpoint.resumed" : "endpoint.paused",
        endpointId,
        result.name as string,
      );
      return endpoint(result);
    });
  }

  getEndpointSecret(endpointId: string): string | undefined {
    return (
      this.db
        .prepare("SELECT secret FROM endpoints WHERE id = ?")
        .get(endpointId) as Row | undefined
    )?.secret as string | undefined;
  }

  submitEvent(input: {
    type: string;
    payload: Record<string, unknown>;
    endpointIds?: string[];
    idempotencyKey: string;
    maxAttempts?: number;
  }): { event: EventRecord; deliveries: Delivery[]; duplicate: boolean } {
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
      throw new RangeError("maxAttempts must be an integer from 1 to 10.");
    const payload = JSON.parse(JSON.stringify(input.payload)) as Record<
      string,
      unknown
    >;
    const endpointIds = input.endpointIds
      ? [...new Set(input.endpointIds)].sort()
      : undefined;
    const requestHash = createHash("sha256")
      .update(
        canonical({
          type: input.type,
          payload,
          endpointIds: endpointIds ?? "*",
          maxAttempts,
        }),
      )
      .digest("hex");
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT * FROM events WHERE idempotencyKey = ?")
        .get(input.idempotencyKey) as Row | undefined;
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw domainError(
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for a different request.",
          );
        return {
          event: event(previous),
          deliveries: this.listDeliveries({
            eventId: previous.id as string,
            limit: 1000,
          }).items,
          duplicate: true,
        };
      }
      const targets = this.listEndpoints().filter(
        (ep) => ep.enabled && (!endpointIds || endpointIds.includes(ep.id)),
      );
      if (
        !targets.length ||
        (endpointIds && targets.length !== endpointIds.length)
      ) {
        throw domainError(
          "INVALID_ENDPOINTS",
          "Choose at least one existing, enabled endpoint.",
        );
      }
      const result: EventRecord = {
        id: id("evt"),
        type: input.type,
        payload,
        createdAt: iso(),
        idempotencyKey: input.idempotencyKey,
      };
      this.db
        .prepare(
          "INSERT INTO events (id,type,payload,idempotencyKey,requestHash,createdAt) VALUES (?,?,?,?,?,?)",
        )
        .run(
          result.id,
          result.type,
          JSON.stringify(payload),
          result.idempotencyKey,
          requestHash,
          result.createdAt,
        );
      const insert = this.db.prepare(`INSERT INTO deliveries
        (id,eventId,endpointId,endpointUrl,status,attempts,maxAttempts,nextAttemptAt,createdAt,updatedAt)
        VALUES (?,?,?,?,'pending',0,?,?,?,?)`);
      for (const ep of targets)
        insert.run(
          id("dlv"),
          result.id,
          ep.id,
          ep.url,
          maxAttempts,
          result.createdAt,
          result.createdAt,
          result.createdAt,
        );
      this.record(
        "event.accepted",
        result.id,
        `${result.type}: ${targets.length} delivery target(s)`,
        result.createdAt,
      );
      return {
        event: result,
        deliveries: this.listDeliveries({ eventId: result.id, limit: 1000 })
          .items,
        duplicate: false,
      };
    });
  }

  getEvent(eventId: string): EventRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(eventId) as Row | undefined;
    return row ? event(row) : undefined;
  }

  listEvents(limit = 50): EventRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM events ORDER BY createdAt DESC, id LIMIT ?")
        .all(limit) as Row[]
    ).map(event);
  }

  listDeliveries(
    input: {
      status?: DeliveryStatus;
      eventId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): { items: Delivery[]; total: number } {
    const where: string[] = [];
    const values: string[] = [];
    if (input.status) {
      where.push("d.status = ?");
      values.push(input.status);
    }
    if (input.eventId) {
      where.push("d.eventId = ?");
      values.push(input.eventId);
    }
    const condition = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM deliveries d ${condition}`)
        .get(...values) as Row
    ).total as number;
    const items = this.db
      .prepare(
        `SELECT ${deliveryFields} ${deliveryJoin} ${condition} ORDER BY d.createdAt DESC, d.id LIMIT ? OFFSET ?`,
      )
      .all(
        ...values,
        input.limit ?? 50,
        input.offset ?? 0,
      ) as unknown as Delivery[];
    return { items, total };
  }

  getDelivery(
    deliveryId: string,
  ):
    | { delivery: Delivery; event: EventRecord; attempts: Attempt[] }
    | undefined {
    const delivery = this.db
      .prepare(`SELECT ${deliveryFields} ${deliveryJoin} WHERE d.id = ?`)
      .get(deliveryId) as unknown as Delivery | undefined;
    if (!delivery) return undefined;
    const attempts = this.db
      .prepare(
        "SELECT id,deliveryId,number,startedAt,finishedAt,statusCode,durationMs,error,responseBody FROM attempts WHERE deliveryId = ? ORDER BY number DESC",
      )
      .all(deliveryId) as unknown as Attempt[];
    return { delivery, event: this.getEvent(delivery.eventId)!, attempts };
  }

  retryDelivery(deliveryId: string): Delivery | undefined {
    return this.transaction(() => {
      const current = this.getDelivery(deliveryId);
      if (!current) return undefined;
      if (
        current.delivery.status !== "dead" &&
        current.delivery.status !== "delivered"
      ) {
        throw domainError(
          "DELIVERY_BUSY",
          "Only completed or dead deliveries can be replayed.",
        );
      }
      const timestamp = iso();
      this.db
        .prepare(
          `UPDATE deliveries SET status='pending', attempts=0, nextAttemptAt=?,
        lastStatusCode=NULL, lastError=NULL, leaseToken=NULL, leaseExpiresAt=NULL, activeAttemptId=NULL, updatedAt=? WHERE id=?`,
        )
        .run(timestamp, timestamp, deliveryId);
      this.record(
        "delivery.replayed",
        deliveryId,
        "Queued a new retry round; attempt history retained.",
        timestamp,
      );
      return this.getDelivery(deliveryId)!.delivery;
    });
  }

  stats(): DashboardStats {
    const counts: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        "SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status",
      )
      .all() as Row[])
      counts[row.status as string] = row.count as number;
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const startHour = currentHour - 23 * 3_600_000;
    const bins = new Map<
      string,
      { hour: string; delivered: number; failed: number }
    >();
    for (let hour = startHour; hour <= currentHour; hour += 3_600_000)
      bins.set(iso(hour), { hour: iso(hour), delivered: 0, failed: 0 });
    const rows = this.db
      .prepare(
        `SELECT substr(finishedAt,1,13) || ':00:00.000Z' AS hour,
      SUM(CASE WHEN statusCode BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN statusCode BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS failed
      FROM attempts WHERE finishedAt >= ? GROUP BY hour`,
      )
      .all(iso(startHour)) as Row[];
    for (const row of rows)
      if (bins.has(row.hour as string))
        bins.set(
          row.hour as string,
          row as unknown as { hour: string; delivered: number; failed: number },
        );
    return {
      endpoints: (
        this.db.prepare("SELECT COUNT(*) AS count FROM endpoints").get() as Row
      ).count as number,
      events: (
        this.db.prepare("SELECT COUNT(*) AS count FROM events").get() as Row
      ).count as number,
      total,
      delivered: counts.delivered ?? 0,
      pending: counts.pending ?? 0,
      processing: counts.processing ?? 0,
      retrying: counts.retrying ?? 0,
      dead: counts.dead ?? 0,
      successRate: total
        ? Math.round(((counts.delivered ?? 0) / total) * 1000) / 10
        : 0,
      activity: [...bins.values()],
    };
  }

  audit(limit = 30): AuditEntry[] {
    return this.db
      .prepare(
        "SELECT id,action,resourceId,createdAt,detail FROM audit ORDER BY createdAt DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as unknown as AuditEntry[];
  }

  /** Recovery and exclusive claim happen in the same write transaction. */
  claimDelivery(nowMs: number, leaseMs: number): DeliveryClaim | undefined {
    return this.transaction(() => {
      const timestamp = iso(nowMs);
      const expired = this.db
        .prepare(
          `SELECT id,activeAttemptId,attempts,maxAttempts FROM deliveries
        WHERE status='processing' AND leaseExpiresAt <= ?`,
        )
        .all(timestamp) as Row[];
      for (const row of expired) {
        const error =
          "Worker lease expired before completion; delivery outcome is unknown.";
        const started = this.db
          .prepare("SELECT startedAt FROM attempts WHERE id=?")
          .get(row.activeAttemptId as string) as Row | undefined;
        if (started)
          this.db
            .prepare(
              "UPDATE attempts SET finishedAt=?,durationMs=?,error=? WHERE id=? AND finishedAt IS NULL",
            )
            .run(
              timestamp,
              Math.max(0, nowMs - Date.parse(started.startedAt as string)),
              error,
              row.activeAttemptId as string,
            );
        const exhausted =
          (row.attempts as number) >= (row.maxAttempts as number);
        this.db
          .prepare(
            `UPDATE deliveries SET status=?,nextAttemptAt=?,lastStatusCode=NULL,lastError=?,
          leaseToken=NULL,leaseExpiresAt=NULL,activeAttemptId=NULL,updatedAt=? WHERE id=?`,
          )
          .run(
            exhausted ? "dead" : "retrying",
            exhausted ? null : timestamp,
            error,
            timestamp,
            row.id as string,
          );
        this.record(
          exhausted ? "delivery.dead" : "delivery.recovered",
          row.id as string,
          error,
          timestamp,
        );
      }
      const selected = this.db
        .prepare(
          `SELECT ${deliveryFields} ${deliveryJoin}
        WHERE d.status IN ('pending','retrying') AND d.nextAttemptAt <= ? AND ep.enabled = 1
        ORDER BY d.nextAttemptAt, d.createdAt, d.id LIMIT 1`,
        )
        .get(timestamp) as unknown as Delivery | undefined;
      if (!selected) return undefined;
      const token = randomUUID();
      const attemptId = id("att");
      const number = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(number),0)+1 AS number FROM attempts WHERE deliveryId=?",
          )
          .get(selected.id) as Row
      ).number as number;
      this.db
        .prepare(
          "INSERT INTO attempts (id,deliveryId,number,startedAt) VALUES (?,?,?,?)",
        )
        .run(attemptId, selected.id, number, timestamp);
      this.db
        .prepare(
          `UPDATE deliveries SET status='processing',attempts=attempts+1,nextAttemptAt=NULL,
        leaseToken=?,leaseExpiresAt=?,activeAttemptId=?,updatedAt=? WHERE id=?`,
        )
        .run(token, iso(nowMs + leaseMs), attemptId, timestamp, selected.id);
      return {
        delivery: this.getDelivery(selected.id)!.delivery,
        event: this.getEvent(selected.eventId)!,
        secret: this.getEndpointSecret(selected.endpointId)!,
        token,
        attemptId,
        startedAt: nowMs,
      };
    });
  }

  /** A stale worker cannot overwrite an attempt after lease expiry or recovery. */
  completeDelivery(claim: DeliveryClaim, outcome: DeliveryOutcome): boolean {
    return this.transaction(() => {
      const timestamp = iso(outcome.nowMs);
      const owned = this.db
        .prepare(
          `SELECT attempts,maxAttempts FROM deliveries
        WHERE id=? AND status='processing' AND leaseToken=? AND leaseExpiresAt > ?`,
        )
        .get(claim.delivery.id, claim.token, timestamp) as Row | undefined;
      if (!owned) return false;
      const retrying =
        !outcome.success &&
        outcome.retryable &&
        (owned.attempts as number) < (owned.maxAttempts as number);
      const status = outcome.success
        ? "delivered"
        : retrying
          ? "retrying"
          : "dead";
      this.db
        .prepare(
          `UPDATE attempts SET finishedAt=?,statusCode=?,durationMs=?,error=?,responseBody=? WHERE id=?`,
        )
        .run(
          timestamp,
          outcome.statusCode,
          Math.max(0, outcome.nowMs - claim.startedAt),
          outcome.error,
          outcome.responseBody,
          claim.attemptId,
        );
      this.db
        .prepare(
          `UPDATE deliveries SET status=?,nextAttemptAt=?,lastStatusCode=?,lastError=?,
        leaseToken=NULL,leaseExpiresAt=NULL,activeAttemptId=NULL,updatedAt=? WHERE id=?`,
        )
        .run(
          status,
          retrying ? iso(outcome.nowMs + outcome.retryDelayMs) : null,
          outcome.statusCode,
          outcome.error,
          timestamp,
          claim.delivery.id,
        );
      this.record(
        `delivery.${status}`,
        claim.delivery.id,
        outcome.success
          ? `HTTP ${outcome.statusCode}`
          : (outcome.error ?? `HTTP ${outcome.statusCode}`),
        timestamp,
      );
      return true;
    });
  }
}
