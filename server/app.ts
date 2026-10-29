import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { tokensEqual, validateTarget, verifySignature } from "./security.js";
import type { DeliveryStatus } from "./types.js";
import { openapi } from "./openapi.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}
const publicPaths = new Set([
  "/api/health",
  "/api/config",
  "/api/docs",
  "/api/openapi.json",
]);
const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", maxLength: 80 } },
};
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}

export async function createApp(
  config: Config,
  options: { store: Store; logger?: boolean; serveStatic?: boolean },
): Promise<FastifyInstance> {
  const store = options.store;
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 65536,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again in a minute.",
      },
    }),
  });
  app.removeContentTypeParser("application/json");
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      request.rawBody = body as string;
      parseJson(request, body as string, done);
    },
  );
  app.addHook("onRequest", async (request, reply) => {
    // Match Fastify's resolved route; raw URLs may contain percent-encoded path characters.
    const pathname = request.routeOptions.url ?? request.url.split("?")[0];
    if (
      !pathname.startsWith("/api/") ||
      publicPaths.has(pathname) ||
      (config.demoMode && pathname === "/api/demo/receiver/:mode")
    )
      return;
    const bearer = request.headers.authorization;
    if (
      !bearer?.startsWith("Bearer ") ||
      !tokensEqual(bearer.slice(7), config.apiToken)
    ) {
      return fail(
        reply,
        401,
        "UNAUTHORIZED",
        "A valid workspace API token is required",
      );
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if ((request.routeOptions.url ?? request.url).startsWith("/api/"))
      reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & {
      code?: string;
      statusCode?: number;
      validation?: unknown;
    };
    if (err.validation)
      return fail(reply, 400, "VALIDATION_ERROR", err.message);
    if (err.code === "IDEMPOTENCY_CONFLICT")
      return fail(
        reply,
        409,
        err.code,
        "This idempotency key was already used for a different event",
      );
    if (err.code === "DELIVERY_BUSY")
      return fail(
        reply,
        409,
        err.code,
        "Only delivered or dead deliveries can be replayed",
      );
    if (err.code === "INVALID_ENDPOINTS")
      return fail(reply, 400, err.code, "Select at least one enabled endpoint");
    if (err.statusCode && err.statusCode < 500)
      return fail(
        reply,
        err.statusCode,
        err.code ?? "BAD_REQUEST",
        err.message,
      );
    request.log.error({ err, requestId: request.id }, "Request failed");
    return fail(
      reply,
      500,
      "INTERNAL_ERROR",
      "The request could not be completed",
    );
  });

  app.get("/api/health", async () => {
    store.db.prepare("SELECT 1").get();
    return { status: "ok", version: "1.0.0" };
  });
  app.get("/api/config", async () => ({ demoMode: config.demoMode }));
  app.get("/api/openapi.json", async () => openapi);
  app.get("/api/docs", async (_request, reply) =>
    reply.type("text/html").send(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RelayForge API</title><style>body{background:#101217;color:#ddd;font:16px/1.8 system-ui;max-width:900px;margin:60px auto;padding:24px}a{color:#ff9c68}code,pre{background:#20242c;padding:5px;border-radius:4px}li{margin:14px 0}</style><h1>RelayForge API</h1><p>可靠 Webhook 投递平台 · v1.0.0</p><p>请求添加 <code>Authorization: Bearer &lt;API_TOKEN&gt;</code>。发布事件还需 <code>Idempotency-Key</code>，相同键与相同内容返回原事件，不重复排队。</p><p><a href="/api/openapi.json">OpenAPI 3.0 文档</a> · <a href="/">管理控制台</a></p><ul>${Object.entries(
        openapi.paths,
      )
        .map(([path, methods]) =>
          Object.entries(methods)
            .map(
              ([method, operation]) =>
                `<li><code>${method.toUpperCase()} ${path}</code> — ${operation.summary}</li>`,
            )
            .join(""),
        )
        .join(
          "",
        )}</ul><h2>签名协议</h2><p>接收端使用 endpoint secret 计算 HMAC-SHA256(timestamp + '.' + 原始请求体)，与 <code>webhook-signature: v1=&lt;hex&gt;</code> 常量时间比较。校验时间戳在 5 分钟内，并按 <code>webhook-id</code> 去重。</p><p>投递采用 at-least-once 语义。请在业务事务内保存事件 ID 并去重。</p></html>`,
    ),
  );
  app.get("/api/stats", async () => store.stats());
  app.get("/api/audit", async () => ({ items: store.audit() }));
  app.get("/api/endpoints", async () => ({ items: store.listEndpoints() }));
  app.post<{ Body: { name: string; url: string } }>(
    "/api/endpoints",
    {
      schema: {
        body: object(
          {
            name: {
              type: "string",
              minLength: 1,
              maxLength: 80,
              pattern: "\\S",
            },
            url: { type: "string", minLength: 1, maxLength: 2048 },
          },
          ["name", "url"],
        ),
      },
    },
    async (request, reply) => {
      let url: URL;
      try {
        url = validateTarget(request.body.url, config);
      } catch (error) {
        return fail(reply, 400, "INVALID_URL", (error as Error).message);
      }
      return reply
        .code(201)
        .send(
          store.createEndpoint({
            name: request.body.name.trim(),
            url: url.href,
          }),
        );
    },
  );
  app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/endpoints/:id",
    {
      schema: {
        params: idParams,
        body: object({ enabled: { type: "boolean" } }, ["enabled"]),
      },
    },
    async (request, reply) => {
      const result = store.setEndpointEnabled(
        request.params.id,
        request.body.enabled,
      );
      return result ?? fail(reply, 404, "NOT_FOUND", "Endpoint not found");
    },
  );
  app.get("/api/events", async () => ({ items: store.listEvents() }));
  app.post<{
    Body: {
      type: string;
      payload: Record<string, unknown>;
      endpointIds?: string[];
    };
  }>(
    "/api/events",
    {
      schema: {
        body: object(
          {
            type: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              pattern: "^[a-zA-Z0-9_.-]+$",
            },
            payload: { type: "object", additionalProperties: true },
            endpointIds: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 80 },
            },
          },
          ["type", "payload"],
        ),
      },
    },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(key))
        return fail(
          reply,
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Provide an Idempotency-Key header (1–128 visible ASCII characters)",
        );
      const result = store.submitEvent({
        ...request.body,
        idempotencyKey: key,
      });
      return reply.code(result.duplicate ? 200 : 201).send(result);
    },
  );
  app.get<{
    Querystring: {
      status?: string;
      eventId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/deliveries", async (request, reply) => {
    const { status, eventId } = request.query;
    if (Object.values(request.query).some((value) => typeof value !== "string"))
      return fail(
        reply,
        400,
        "VALIDATION_ERROR",
        "Filters must have a single string value",
      );
    const limit = Number(request.query.limit ?? 50),
      offset = Number(request.query.offset ?? 0);
    if (
      (status &&
        !["pending", "processing", "retrying", "delivered", "dead"].includes(
          status,
        )) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      (eventId && eventId.length > 80)
    ) {
      return fail(
        reply,
        400,
        "VALIDATION_ERROR",
        "Invalid delivery filters or pagination",
      );
    }
    return store.listDeliveries({
      status: status as DeliveryStatus | undefined,
      eventId,
      limit,
      offset,
    });
  });
  app.get<{ Params: { id: string } }>(
    "/api/deliveries/:id",
    { schema: { params: idParams } },
    async (request, reply) =>
      store.getDelivery(request.params.id) ??
      fail(reply, 404, "NOT_FOUND", "Delivery not found"),
  );
  app.post<{ Params: { id: string } }>(
    "/api/deliveries/:id/retry",
    { schema: { params: idParams } },
    async (request, reply) =>
      store.retryDelivery(request.params.id) ??
      fail(reply, 404, "NOT_FOUND", "Delivery not found"),
  );

  if (config.demoMode) {
    app.post("/api/demo/bootstrap", async (_request, reply) => {
      const existing = store.listEndpoints();
      const endpoints = (["good", "flaky", "reject"] as const).map((mode) => {
        const url = `http://127.0.0.1:${config.port}/api/demo/receiver/${mode}`;
        const match = existing.find((endpoint) => endpoint.url === url);
        if (match) return store.setEndpointEnabled(match.id, true)!;
        return store.createEndpoint({
          name: {
            good: "订单服务 · 正常响应",
            flaky: "通知服务 · 失败后恢复",
            reject: "风控服务 · 拒绝请求",
          }[mode],
          url,
        });
      });
      const result = store.submitEvent({
        type: "order.created",
        payload: {
          orderId: `ORD-${Date.now().toString().slice(-6)}`,
          amount: 29900,
          currency: "CNY",
          customer: "Demo Customer",
        },
        endpointIds: endpoints.map((endpoint) => endpoint.id),
        idempotencyKey: randomUUID(),
      });
      return reply
        .code(201)
        .send({
          event: result.event,
          deliveries: result.deliveries,
          endpoints: endpoints.map(({ id, name, url, enabled, createdAt }) => ({
            id,
            name,
            url,
            enabled,
            createdAt,
          })),
        });
    });
    app.post<{ Params: { mode: string } }>(
      "/api/demo/receiver/:mode",
      async (request, reply) => {
        const mode = request.params.mode;
        if (!["good", "flaky", "reject"].includes(mode))
          return fail(reply, 404, "NOT_FOUND", "Receiver not found");
        const id = request.headers["webhook-delivery-id"];
        const detail =
          typeof id === "string" ? store.getDelivery(id) : undefined;
        const timestamp = request.headers["webhook-timestamp"],
          signature = request.headers["webhook-signature"];
        const secret = detail
          ? store.getEndpointSecret(detail.delivery.endpointId)
          : undefined;
        if (
          !detail ||
          detail.delivery.endpointUrl !==
            `http://127.0.0.1:${config.port}/api/demo/receiver/${mode}` ||
          !secret ||
          typeof timestamp !== "string" ||
          typeof signature !== "string" ||
          !verifySignature(request.rawBody ?? "", timestamp, signature, secret)
        ) {
          return fail(
            reply,
            401,
            "INVALID_SIGNATURE",
            "A valid webhook signature is required",
          );
        }
        if (mode === "reject")
          return reply
            .code(400)
            .send({ error: "Demo: permanent business validation failure" });
        if (mode === "flaky" && detail.delivery.attempts <= 2)
          return reply
            .code(503)
            .send({
              error: "Demo: temporarily unavailable; retry this request",
            });
        return { accepted: true, eventId: detail.event.id };
      },
    );
  }
  // Both tsx development and compiled production serve the Vite build, if present.
  const staticRoot = resolve("dist/web");
  if (
    options.serveStatic !== false &&
    existsSync(resolve(staticRoot, "index.html"))
  ) {
    await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/assets/"))
        return fail(reply, 404, "NOT_FOUND", "Route not found");
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((_request, reply) =>
      fail(
        reply,
        404,
        "NOT_FOUND",
        "Route not found. Build the dashboard with npm run build.",
      ),
    );
  }
  return app;
}
