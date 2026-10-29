export type DeliveryStatus =
  "pending" | "processing" | "retrying" | "delivered" | "dead";
export interface Endpoint {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
}
export interface EventRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  idempotencyKey: string;
}
export interface Delivery {
  id: string;
  eventId: string;
  endpointId: string;
  eventType: string;
  endpointName: string;
  endpointUrl: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Attempt {
  id: string;
  deliveryId: string;
  number: number;
  startedAt: string;
  finishedAt: string | null;
  statusCode: number | null;
  durationMs: number | null;
  error: string | null;
  responseBody: string | null;
}
export interface DashboardStats {
  endpoints: number;
  events: number;
  total: number;
  delivered: number;
  pending: number;
  processing: number;
  retrying: number;
  dead: number;
  successRate: number;
  activity: { hour: string; delivered: number; failed: number }[];
}
export interface AuditEntry {
  id: string;
  action: string;
  resourceId: string;
  createdAt: string;
  detail: string;
}
