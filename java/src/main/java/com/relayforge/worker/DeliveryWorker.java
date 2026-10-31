package com.relayforge.worker;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.relayforge.store.Models.Claim;
import com.relayforge.store.Models.Outcome;
import com.relayforge.store.RelayStore;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.DoubleSupplier;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/** One durable claim per tick; no database transaction remains open while HTTP is in flight. */
@Service
public class DeliveryWorker {
    private static final Logger LOG = LoggerFactory.getLogger(DeliveryWorker.class);
    private final RelayStore store;
    private final Transport transport;
    private final ObjectMapper mapper;
    private final boolean enabled;
    private final LongSupplier now;
    private final DoubleSupplier random;
    private final long retryBaseMs;
    private final long leaseMs;
    private boolean stopping;

    @Autowired
    public DeliveryWorker(RelayStore store, Transport transport, ObjectMapper mapper,
                          @Value("${relay.retry-base-ms:1000}") long retryBaseMs,
                          @Value("${relay.worker-enabled:true}") boolean enabled) {
        this(store, transport, mapper, enabled, System::currentTimeMillis, Math::random, retryBaseMs, 30_000);
    }

    DeliveryWorker(RelayStore store, Transport transport, ObjectMapper mapper, boolean enabled,
                   LongSupplier now, DoubleSupplier random, long retryBaseMs, long leaseMs) {
        if (retryBaseMs < 100 || retryBaseMs > 60_000 || leaseMs < 1) throw new IllegalArgumentException("Invalid worker retry or lease configuration");
        this.store = store;
        this.transport = transport;
        this.mapper = mapper;
        this.enabled = enabled;
        this.now = now;
        this.random = random;
        this.retryBaseMs = retryBaseMs;
        this.leaseMs = leaseMs;
    }

    @Scheduled(fixedDelayString = "${relay.worker-poll-ms:250}", initialDelayString = "${relay.worker-initial-delay-ms:1000}")
    public void poll() {
        if (!enabled) return;
        try { tick(); }
        catch (RuntimeException error) { LOG.error("Webhook worker iteration failed; any unfinished lease will recover", error); }
    }

    /** Synchronization also ensures bean destruction waits for the current bounded HTTP exchange. */
    public synchronized boolean tick() {
        if (stopping) return false;
        Claim claim = store.claimDelivery(now.getAsLong(), leaseMs);
        if (claim == null) return false;
        String body = envelope(claim);
        String timestamp = Long.toString(now.getAsLong() / 1000);
        Map<String, String> headers = Map.of(
                "content-type", "application/json", "user-agent", "RelayForge/2.0",
                "webhook-id", claim.event().id(), "webhook-delivery-id", claim.delivery().id(),
                "webhook-timestamp", timestamp, "webhook-signature", WebhookSecurity.sign(body, timestamp, claim.secret()));
        Integer statusCode = null;
        String responseBody = null;
        String error = null;
        boolean success = false;
        boolean retryable = true;
        try {
            Transport.Response response = transport.send(new Transport.Request(claim.delivery().endpointUrl(), body, headers));
            statusCode = response.statusCode();
            byte[] responseBytes = response.body().getBytes(StandardCharsets.UTF_8);
            responseBody = new String(responseBytes, 0, Math.min(responseBytes.length, 4096), StandardCharsets.UTF_8);
            success = statusCode >= 200 && statusCode < 300;
            retryable = statusCode == 408 || statusCode == 425 || statusCode == 429 || (statusCode >= 500 && statusCode < 600);
            if (!success) error = "HTTP " + statusCode;
        } catch (Exception caught) {
            error = clean(caught.getMessage() == null ? "Network request failed" : caught.getMessage(), claim.secret());
        }
        long ceiling = Math.min(60_000, retryBaseMs * (1L << Math.max(0, Math.min(20, claim.delivery().attempts() - 1))));
        double sample = random.getAsDouble();
        if (!Double.isFinite(sample)) sample = 0.5;
        long delay = (long) Math.floor(Math.min(1, Math.max(0, sample)) * ceiling);
        store.completeDelivery(claim, new Outcome(now.getAsLong(), statusCode, responseBody, error, success, retryable, delay));
        return true;
    }

    private String envelope(Claim claim) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("id", claim.event().id());
        envelope.put("type", claim.event().type());
        envelope.put("createdAt", claim.event().createdAt());
        envelope.put("data", claim.event().payload());
        try { return mapper.writeValueAsString(envelope); }
        catch (JsonProcessingException error) { throw new IllegalStateException("Cannot serialize stored webhook event", error); }
    }

    private static String clean(String message, String secret) {
        String safe = message.replace(secret, "[redacted]").replaceAll("[\\x00-\\x1f\\x7f]", " ");
        return safe.substring(0, Math.min(safe.length(), 500));
    }

    @PreDestroy
    public synchronized void shutdown() { stopping = true; }
}
