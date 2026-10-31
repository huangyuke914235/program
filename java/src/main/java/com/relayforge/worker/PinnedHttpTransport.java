package com.relayforge.worker;

import jakarta.annotation.PreDestroy;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.apache.hc.client5.http.DnsResolver;
import org.apache.hc.client5.http.classic.methods.HttpPost;
import org.apache.hc.client5.http.config.ConnectionConfig;
import org.apache.hc.client5.http.config.RequestConfig;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManager;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManagerBuilder;
import org.apache.hc.core5.http.ContentType;
import org.apache.hc.core5.http.io.entity.ByteArrayEntity;
import org.apache.hc.core5.io.CloseMode;
import org.apache.hc.core5.util.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Validates all DNS answers, then connects through a resolver containing only that validated IP. */
@Component
public class PinnedHttpTransport implements Transport, AutoCloseable {
    @FunctionalInterface
    interface HostResolver { InetAddress[] resolve(String hostname) throws IOException; }

    private final boolean demoMode;
    private final int port;
    private final HostResolver resolver;
    private final Duration dnsTimeout;
    private final Duration httpTimeout;
    private final ExecutorService dnsExecutor;
    private final ScheduledExecutorService deadlines;

    @Autowired
    public PinnedHttpTransport(@Value("${relay.demo-mode:false}") boolean demoMode, @Value("${server.port:3000}") int port) {
        this(demoMode, port, InetAddress::getAllByName, Duration.ofSeconds(3), Duration.ofSeconds(10));
    }

    PinnedHttpTransport(boolean demoMode, int port, HostResolver resolver, Duration dnsTimeout, Duration httpTimeout) {
        this.demoMode = demoMode;
        this.port = port;
        this.resolver = resolver;
        this.dnsTimeout = dnsTimeout;
        this.httpTimeout = httpTimeout;
        ThreadFactory factory = runnable -> {
            Thread thread = new Thread(runnable, "relayforge-outbound-io");
            thread.setDaemon(true);
            return thread;
        };
        // Native DNS may ignore interruption. Bound both the thread count and queued work.
        this.dnsExecutor = new ThreadPoolExecutor(0, 4, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), factory);
        this.deadlines = Executors.newSingleThreadScheduledExecutor(factory);
    }

    @Override
    public Response send(Request input) throws IOException {
        URI target;
        try { target = WebhookSecurity.validateTarget(input.url(), demoMode, port); }
        catch (IllegalArgumentException error) { throw new IOException(error.getMessage()); }
        String hostname = WebhookSecurity.hostname(target);
        InetAddress pinned = WebhookSecurity.isDemoTarget(target, demoMode, port)
                ? InetAddress.getByAddress(new byte[] {127, 0, 0, 1}) : resolvePublic(hostname);
        DnsResolver pinnedResolver = new PinnedResolver(hostname, pinned);
        Timeout timeout = Timeout.ofMilliseconds(httpTimeout.toMillis());
        PoolingHttpClientConnectionManager manager = PoolingHttpClientConnectionManagerBuilder.create()
                .setDnsResolver(pinnedResolver)
                .setDefaultConnectionConfig(ConnectionConfig.custom().setConnectTimeout(timeout).setSocketTimeout(timeout).build())
                .setMaxConnTotal(1).setMaxConnPerRoute(1).build();
        HttpPost post = new HttpPost(target);
        input.headers().forEach(post::setHeader);
        post.setEntity(new ByteArrayEntity(input.body().getBytes(StandardCharsets.UTF_8), ContentType.APPLICATION_JSON));
        post.setConfig(RequestConfig.custom().setResponseTimeout(timeout).setConnectionRequestTimeout(timeout)
                .setRedirectsEnabled(false).setAuthenticationEnabled(false).setContentCompressionEnabled(false)
                .setHardCancellationEnabled(true).build());
        try (CloseableHttpClient client = HttpClients.custom().setConnectionManager(manager)
                .disableRedirectHandling().disableAutomaticRetries().disableCookieManagement()
                .disableAuthCaching().disableContentCompression().build()) {
            ScheduledFuture<?> deadline = deadlines.schedule(() -> {
                post.cancel();
                manager.close(CloseMode.IMMEDIATE);
            }, httpTimeout.toMillis(), TimeUnit.MILLISECONDS);
            try {
                // The target URI retains the original hostname for Host, TLS SNI and certificate verification.
                return client.execute(post, response -> {
                    String body = "";
                    if (response.getEntity() != null) {
                        try (InputStream stream = response.getEntity().getContent()) {
                            body = readBounded(stream, post);
                        }
                    }
                    return new Response(response.getCode(), body);
                });
            } finally { deadline.cancel(false); }
        } finally { manager.close(CloseMode.IMMEDIATE); }
    }

    InetAddress resolvePublic(String hostname) throws IOException {
        final Future<InetAddress[]> future;
        try { future = dnsExecutor.submit(() -> resolver.resolve(hostname)); }
        catch (RejectedExecutionException error) { throw new IOException("Destination DNS resolver is busy", error); }
        try {
            InetAddress[] addresses = future.get(dnsTimeout.toMillis(), TimeUnit.MILLISECONDS);
            if (addresses == null || addresses.length == 0 || addresses.length > 64
                    || Arrays.stream(addresses).anyMatch(address -> !WebhookSecurity.isPublicAddress(address))) {
                throw new IOException("Destination DNS resolves to a private or reserved address");
            }
            return addresses[0];
        } catch (TimeoutException error) {
            future.cancel(true);
            throw new IOException("Destination DNS lookup timed out", error);
        } catch (InterruptedException error) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            throw new IOException("Destination DNS lookup interrupted", error);
        } catch (ExecutionException error) {
            throw new IOException("Destination DNS lookup failed", error.getCause());
        }
    }

    private static String readBounded(InputStream input, HttpPost post) throws IOException {
        ByteArrayOutputStream captured = new ByteArrayOutputStream(4096);
        byte[] buffer = new byte[8192];
        int count;
        int total = 0;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > 1024 * 1024) {
                post.cancel();
                throw new IOException("Receiver response exceeds 1 MiB");
            }
            int keep = Math.min(count, 4096 - captured.size());
            if (keep > 0) captured.write(buffer, 0, keep);
        }
        return captured.toString(StandardCharsets.UTF_8);
    }

    /** No DNS, reverse DNS, fallback, or system proxy lookup is allowed during socket connection. */
    static final class PinnedResolver implements DnsResolver {
        private final String hostname;
        private final InetAddress address;

        PinnedResolver(String hostname, InetAddress address) { this.hostname = hostname; this.address = address; }

        @Override
        public InetAddress[] resolve(String host) throws UnknownHostException {
            if (!hostname.equalsIgnoreCase(host)) throw new UnknownHostException("Unexpected connection hostname");
            return new InetAddress[] {address};
        }

        @Override
        public String resolveCanonicalHostname(String host) throws UnknownHostException {
            if (!hostname.equalsIgnoreCase(host)) throw new UnknownHostException("Unexpected connection hostname");
            return host;
        }
    }

    @PreDestroy
    @Override
    public void close() { dnsExecutor.shutdownNow(); deadlines.shutdownNow(); }
}
