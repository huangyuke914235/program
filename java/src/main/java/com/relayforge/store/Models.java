package com.relayforge.store;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

public final class Models {
    private Models() {}
    public record Endpoint(String id, String name, String url, boolean enabled, String createdAt) {}
    public record CreatedEndpoint(String id, String name, String url, boolean enabled, String createdAt, String secret) {}
    public record EventRecord(String id, String type, JsonNode payload, String createdAt, String idempotencyKey) {}
    public record Delivery(String id, String eventId, String endpointId, String eventType, String endpointName,
        String endpointUrl, String status, int attempts, int maxAttempts, String nextAttemptAt,
        Integer lastStatusCode, String lastError, String createdAt, String updatedAt) {}
    public record Attempt(String id, String deliveryId, int number, String startedAt, String finishedAt,
        Integer statusCode, Long durationMs, String error, String responseBody) {}
    public record DeliveryPage(List<Delivery> items, long total) {}
    public record Detail(Delivery delivery, EventRecord event, List<Attempt> attempts) {}
    public record SubmitResult(EventRecord event, List<Delivery> deliveries, boolean duplicate) {}
    public record Hour(String hour, long delivered, long failed) {}
    public record DashboardStats(long endpoints, long events, long total, long delivered, long pending,
        long processing, long retrying, long dead, double successRate, List<Hour> activity) {}
    public record AuditEntry(String id, String action, String resourceId, String createdAt, String detail) {}
    public record Claim(Delivery delivery, EventRecord event, String secret, String token, String attemptId, long startedAt) {}
    public record Outcome(long nowMs, Integer statusCode, String responseBody, String error,
        boolean success, boolean retryable, long retryDelayMs) {}
}
