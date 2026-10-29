const security = [{ bearerAuth: [] }];
const response = (description: string) => ({ description });
const jsonBody = (schema: object) => ({
  required: true,
  content: { "application/json": { schema } },
});
const pathId = [
  { name: "id", in: "path", required: true, schema: { type: "string" } },
];

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "RelayForge API",
    version: "1.0.0",
    description:
      "Reliable webhook delivery. Authenticate with the workspace API token. Delivery is at least once.",
  },
  servers: [{ url: "/" }],
  security,
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  paths: {
    "/api/health": {
      get: {
        summary: "Liveness and database check",
        security: [],
        responses: { "200": response("Healthy") },
      },
    },
    "/api/config": {
      get: {
        summary: "Public UI configuration",
        security: [],
        responses: { "200": response("demoMode flag") },
      },
    },
    "/api/stats": {
      get: {
        summary: "Queue counts and 24-hour activity",
        responses: { "200": response("DashboardStats") },
      },
    },
    "/api/endpoints": {
      get: {
        summary: "List endpoints (secrets excluded)",
        responses: { "200": response("{ items: Endpoint[] }") },
      },
      post: {
        summary: "Create endpoint; signing secret returned once",
        requestBody: jsonBody({
          type: "object",
          required: ["name", "url"],
          properties: {
            name: { type: "string", maxLength: 80 },
            url: { type: "string", format: "uri" },
          },
        }),
        responses: {
          "201": response("Endpoint and secret"),
          "400": response("Invalid destination"),
        },
      },
    },
    "/api/endpoints/{id}": {
      patch: {
        summary: "Pause or resume an endpoint",
        parameters: pathId,
        requestBody: jsonBody({
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        }),
        responses: {
          "200": response("Endpoint"),
          "404": response("Missing endpoint"),
        },
      },
    },
    "/api/events": {
      get: {
        summary: "List most recent events",
        responses: { "200": response("{ items: EventRecord[] }") },
      },
      post: {
        summary: "Atomically accept event and queue deliveries",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", maxLength: 128 },
          },
        ],
        requestBody: jsonBody({
          type: "object",
          required: ["type", "payload"],
          properties: {
            type: { type: "string", example: "order.created" },
            payload: { type: "object", additionalProperties: true },
            endpointIds: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
          },
        }),
        responses: {
          "201": response("New event and deliveries"),
          "200": response("Duplicate event, original deliveries"),
          "409": response("Key reused with different input"),
        },
      },
    },
    "/api/deliveries": {
      get: {
        summary: "List deliveries",
        parameters: [
          {
            name: "status",
            in: "query",
            schema: {
              type: "string",
              enum: ["pending", "processing", "retrying", "delivered", "dead"],
            },
          },
          { name: "eventId", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, minimum: 1, maximum: 100 },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0, minimum: 0 },
          },
        ],
        responses: { "200": response("{ items: Delivery[], total: number }") },
      },
    },
    "/api/deliveries/{id}": {
      get: {
        summary: "Delivery, event payload and attempt history",
        parameters: pathId,
        responses: {
          "200": response("{ delivery, event, attempts }"),
          "404": response("Missing delivery"),
        },
      },
    },
    "/api/deliveries/{id}/retry": {
      post: {
        summary: "Replay a delivered or dead delivery",
        parameters: pathId,
        responses: {
          "200": response("Queued delivery; attempt history retained"),
          "409": response("Already queued or processing"),
        },
      },
    },
    "/api/audit": {
      get: {
        summary: "Recent control-plane audit entries",
        responses: { "200": response("{ items: AuditEntry[] }") },
      },
    },
    "/api/demo/bootstrap": {
      post: {
        summary:
          "Create demo endpoints and send an order event (demo mode only)",
        responses: {
          "201": response("Demo seeded"),
          "404": response("Demo disabled"),
        },
      },
    },
  },
};
