package com.relayforge.worker;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.relayforge.store.Models.Claim;
import com.relayforge.store.Models.Delivery;
import com.relayforge.store.Models.EventRecord;
import com.relayforge.store.Models.Outcome;
import com.relayforge.store.RelayStore;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;

class DeliveryWorkerTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final RelayStore store = mock(RelayStore.class);
    private static final long NOW = 1700000000000L;

    private Claim claim(int attempts) {
        Delivery delivery = new Delivery("dlv_test", "evt_test", "ep_test", "order.created", "Shop", "https://example.com/hook", "processing", attempts, 5, null, null, null, "2023-11-14T22:13:20.000Z", "2023-11-14T22:13:20.000Z");
        EventRecord event = new EventRecord("evt_test", "order.created", mapper.createObjectNode().put("orderId", "ORD-42"), "2023-11-14T22:13:20.000Z", "order_42");
        return new Claim(delivery, event, "whsec_test", "lease_test", "att_test", NOW);
    }

    private DeliveryWorker worker(Transport transport) {
        return new DeliveryWorker(store, transport, mapper, true, () -> NOW, () -> 0.5, 1000, 30_000);
    }

    private Outcome completed() {
        ArgumentCaptor<Outcome> result = ArgumentCaptor.forClass(Outcome.class);
        verify(store).completeDelivery(any(Claim.class), result.capture());
        return result.getValue();
    }

    @Test
    void signsTheExactTransmittedBodyAndUsesTheOriginalEventIdentity() throws Exception {
        when(store.claimDelivery(NOW, 30_000)).thenReturn(claim(1));
        AtomicReference<Transport.Request> sent = new AtomicReference<>();
        DeliveryWorker worker = worker(request -> { sent.set(request); return new Transport.Response(204, ""); });
        assertTrue(worker.tick());
        Transport.Request request = sent.get();
        assertEquals("evt_test", request.headers().get("webhook-id"));
        assertEquals("dlv_test", request.headers().get("webhook-delivery-id"));
        assertTrue(WebhookSecurity.verifySignature(request.body(), request.headers().get("webhook-timestamp"), request.headers().get("webhook-signature"), "whsec_test", NOW));
        assertEquals("ORD-42", mapper.readTree(request.body()).path("data").path("orderId").asText());
        assertEquals("evt_test", mapper.readTree(request.body()).path("id").asText());
        Outcome outcome = completed();
        assertTrue(outcome.success());
        assertFalse(outcome.retryable());
    }

    @ParameterizedTest
    @ValueSource(ints = {408, 425, 429, 500, 503})
    void transientHttpResponsesUseDurableRetryAndFullJitter(int status) {
        when(store.claimDelivery(NOW, 30_000)).thenReturn(claim(2));
        assertTrue(worker(request -> new Transport.Response(status, "temporary")).tick());
        Outcome outcome = completed();
        assertFalse(outcome.success());
        assertTrue(outcome.retryable());
        assertEquals(1000, outcome.retryDelayMs()); // attempt 2 => ceiling 2000 => sample 0.5.
        assertEquals(status, outcome.statusCode());
    }

    @ParameterizedTest
    @ValueSource(ints = {301, 302, 400, 401, 404, 422, 600})
    void redirectsAndPermanentHttpErrorsAreNotRetried(int status) {
        when(store.claimDelivery(NOW, 30_000)).thenReturn(claim(1));
        worker(request -> new Transport.Response(status, "permanent")).tick();
        Outcome outcome = completed();
        assertFalse(outcome.success());
        assertFalse(outcome.retryable());
    }

    @Test
    void networkFailuresAreRetriedAndSecretsAreRedactedFromBoundedErrors() {
        when(store.claimDelivery(NOW, 30_000)).thenReturn(claim(1));
        worker(request -> { throw new IOException("bad\nwhsec_test\r" + "x".repeat(1000)); }).tick();
        Outcome outcome = completed();
        assertTrue(outcome.retryable());
        assertNull(outcome.statusCode());
        assertFalse(outcome.error().contains("whsec_test"));
        assertFalse(outcome.error().contains("\n"));
        assertEquals(500, outcome.error().length());
    }

    @Test
    void responseCaptureAndExponentialBackoffHaveHardCaps() {
        when(store.claimDelivery(NOW, 30_000)).thenReturn(claim(10));
        worker(request -> new Transport.Response(503, "a".repeat(20000))).tick();
        Outcome outcome = completed();
        assertEquals(4096, outcome.responseBody().length());
        assertEquals(30_000, outcome.retryDelayMs()); // ceiling capped at 60s.
    }

    @Test
    void noDueClaimMeansNoHttpRequestAndNoCompletion() throws Exception {
        Transport transport = mock(Transport.class);
        assertFalse(worker(transport).tick());
        verifyNoInteractions(transport);
        verify(store, never()).completeDelivery(any(), any());
    }

    @Test
    void aDisabledSchedulerDoesNotClaimJobsAndShutdownPreventsFurtherTicks() {
        DeliveryWorker disabled = new DeliveryWorker(store, request -> new Transport.Response(200, "ok"), mapper, false, () -> NOW, () -> 0.5, 1000, 30_000);
        disabled.poll();
        verifyNoInteractions(store);
        disabled.shutdown();
        assertFalse(disabled.tick());
        verifyNoInteractions(store);
    }
}
