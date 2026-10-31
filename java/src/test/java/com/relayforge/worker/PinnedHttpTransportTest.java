package com.relayforge.worker;

import static org.junit.jupiter.api.Assertions.*;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class PinnedHttpTransportTest {
    @Test
    void realHttpPreservesUnicodeBytesAndWebhookHeadersWithoutFollowingRedirects() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> received = new AtomicReference<>();
        AtomicReference<String> signature = new AtomicReference<>();
        List<String> paths = new ArrayList<>();
        server.createContext("/", exchange -> {
            paths.add(exchange.getRequestURI().getPath());
            received.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            signature.set(exchange.getRequestHeaders().getFirst("webhook-signature"));
            exchange.getResponseHeaders().set("Location", "/private/admin");
            byte[] response = "moved".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(302, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        int port = server.getAddress().getPort();
        String body = "{\"message\":\"订单已支付 🧾\"}";
        try (PinnedHttpTransport transport = new PinnedHttpTransport(true, port)) {
            Transport.Response response = transport.send(new Transport.Request("http://127.0.0.1:" + port + "/api/demo/receiver/shop", body, Map.of("webhook-signature", "v1=test")));
            assertEquals(body, received.get());
            assertEquals("v1=test", signature.get());
            assertEquals(302, response.statusCode());
            assertEquals("moved", response.body());
            assertEquals(List.of("/api/demo/receiver/shop"), paths);
        } finally { server.stop(0); }
    }

    @Test
    void responseHistoryIsBoundedAndOversizedStreamsAreTerminated() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger size = new AtomicInteger(20_000);
        server.createContext("/", exchange -> {
            byte[] bytes = new byte[size.get()];
            java.util.Arrays.fill(bytes, (byte) 'a');
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, bytes.length);
            try { exchange.getResponseBody().write(bytes); }
            catch (IOException ignored) { /* The client intentionally aborts oversized responses. */ }
            finally { exchange.close(); }
        });
        server.start();
        int port = server.getAddress().getPort();
        try (PinnedHttpTransport transport = new PinnedHttpTransport(true, port)) {
            Transport.Request request = new Transport.Request("http://127.0.0.1:" + port + "/api/demo/receiver/good", "{}", Map.of());
            assertEquals("a".repeat(4096), transport.send(request).body());
            size.set(2 * 1024 * 1024);
            IOException error = assertThrows(IOException.class, () -> transport.send(request));
            assertTrue(error.getMessage().contains("1 MiB"));
        } finally { server.stop(0); }
    }

    @Test
    void aSlowTrickleCannotExtendTheAbsoluteHttpDeadline() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, 0);
            try {
                for (int i = 0; i < 20; i++) {
                    exchange.getResponseBody().write('a');
                    exchange.getResponseBody().flush();
                    Thread.sleep(30);
                }
            } catch (IOException ignored) {
                // The deadline closes the client connection even while bytes keep arriving.
            } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            finally { exchange.close(); }
        });
        server.start();
        int port = server.getAddress().getPort();
        try (PinnedHttpTransport transport = new PinnedHttpTransport(true, port, InetAddress::getAllByName, Duration.ofMillis(100), Duration.ofMillis(120))) {
            long started = System.nanoTime();
            assertThrows(IOException.class, () -> transport.send(new Transport.Request("http://127.0.0.1:" + port + "/api/demo/receiver/good", "{}", Map.of())));
            assertTrue(Duration.ofNanos(System.nanoTime() - started).toMillis() < 1500);
        } finally { server.stop(0); }
    }

    @Test
    void privateAndMixedDnsAnswersFailClosedBeforeConnection() throws Exception {
        InetAddress privateAddress = InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        InetAddress publicAddress = InetAddress.getByAddress(new byte[] {1, 1, 1, 1});
        for (InetAddress[] addresses : new InetAddress[][] {{privateAddress}, {publicAddress, privateAddress}}) {
            try (PinnedHttpTransport transport = new PinnedHttpTransport(false, 3000, hostname -> addresses, Duration.ofSeconds(1), Duration.ofSeconds(1))) {
                IOException error = assertThrows(IOException.class, () -> transport.send(new Transport.Request("http://receiver.example.test/hook", "{}", Map.of())));
                assertTrue(error.getMessage().contains("private or reserved"));
            }
        }
    }

    @Test
    void dnsResolutionHasItsOwnDeadline() throws Exception {
        try (PinnedHttpTransport transport = new PinnedHttpTransport(false, 3000, hostname -> {
            try { Thread.sleep(5000); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException("interrupted", error); }
            return new InetAddress[] {InetAddress.getByAddress(new byte[] {1, 1, 1, 1})};
        }, Duration.ofMillis(40), Duration.ofSeconds(1))) {
            long started = System.nanoTime();
            IOException error = assertThrows(IOException.class, () -> transport.resolvePublic("receiver.example.test"));
            assertTrue(error.getMessage().contains("DNS lookup timed out"));
            assertTrue(Duration.ofNanos(System.nanoTime() - started).toMillis() < 1000);
        }
    }

    @Test
    void theConnectionResolverContainsOnlyTheAlreadyValidatedAddress() throws Exception {
        InetAddress publicAddress = InetAddress.getByAddress(new byte[] {1, 1, 1, 1});
        PinnedHttpTransport.PinnedResolver resolver = new PinnedHttpTransport.PinnedResolver("receiver.example.test", publicAddress);
        assertArrayEquals(new InetAddress[] {publicAddress}, resolver.resolve("receiver.example.test"));
        assertArrayEquals(new InetAddress[] {publicAddress}, resolver.resolve("RECEIVER.EXAMPLE.TEST"));
        assertEquals("receiver.example.test", resolver.resolveCanonicalHostname("receiver.example.test"));
        assertThrows(java.net.UnknownHostException.class, () -> resolver.resolve("other.example.test"));
    }
}
