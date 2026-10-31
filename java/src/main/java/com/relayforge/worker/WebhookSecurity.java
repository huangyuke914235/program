package com.relayforge.worker;

import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** URL admission and wire-signature rules shared by the API and outbound worker. */
public final class WebhookSecurity {
    private WebhookSecurity() {}

    public static String sign(String body, String timestamp, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal((timestamp + "." + body).getBytes(StandardCharsets.UTF_8));
            return "v1=" + HexFormat.of().formatHex(digest);
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("HMAC-SHA256 is unavailable", error);
        }
    }

    public static boolean tokensEqual(String actual, String expected) {
        if (actual == null || expected == null) return false;
        try {
            MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
            return MessageDigest.isEqual(sha256.digest(actual.getBytes(StandardCharsets.UTF_8)),
                    sha256.digest(expected.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    public static boolean verifySignature(String body, String timestamp, String signature, String secret, long nowMs) {
        if (body == null || timestamp == null || signature == null || secret == null
                || !timestamp.matches("\\d{1,12}") || !signature.matches("v1=[a-f0-9]{64}")) return false;
        if (Math.abs(nowMs / 1000.0 - Long.parseLong(timestamp)) > 300) return false;
        return tokensEqual(signature, sign(body, timestamp, secret));
    }

    /** Does not resolve hostnames. Every resolved address is checked again immediately before connecting. */
    public static URI validateTarget(String raw, boolean demoMode, int port) {
        if (raw == null || raw.isBlank() || raw.length() > 2048) throw new IllegalArgumentException("Enter an absolute HTTP(S) URL of at most 2048 characters");
        final URI uri;
        try { uri = new URI(raw); }
        catch (URISyntaxException error) { throw new IllegalArgumentException("Enter a valid absolute HTTP or HTTPS URL"); }
        String scheme = uri.getScheme();
        if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))
                || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || uri.isOpaque() || uri.getPort() == 0 || uri.getPort() > 65535) {
            throw new IllegalArgumentException("Use HTTP(S) without credentials or a fragment and a valid host/port");
        }
        if (isDemoTarget(uri, demoMode, port)) return uri;
        String hostname = hostname(uri).toLowerCase(Locale.ROOT);
        if (hostname.equals("localhost") || hostname.endsWith(".localhost")
                || hostname.equals("localhost.") || hostname.endsWith(".localhost.")) {
            throw new IllegalArgumentException("Private and reserved network destinations are blocked");
        }
        try {
            if (hostname.contains(":")) {
                // Numeric IPv6 parsing never performs DNS. IPv4-mapped literals are rejected too.
                InetAddress address = InetAddress.getByName(hostname);
                if (address.getAddress().length != 16 || !isPublicAddress(address)) throw blocked();
            } else if (hostname.matches("[0-9.]+")) {
                String[] octets = hostname.split("\\.", -1);
                if (octets.length != 4) throw blocked();
                byte[] bytes = new byte[4];
                for (int i = 0; i < 4; i++) {
                    if (octets[i].isEmpty() || octets[i].length() > 3 || (octets[i].length() > 1 && octets[i].startsWith("0"))) throw blocked();
                    int number = Integer.parseInt(octets[i]);
                    if (number > 255) throw blocked();
                    bytes[i] = (byte) number;
                }
                if (!isPublicAddress(InetAddress.getByAddress(bytes))) throw blocked();
            } else if (hostname.matches("(?i)0x[0-9a-f]+")) {
                throw blocked();
            }
        } catch (UnknownHostException | NumberFormatException error) {
            throw new IllegalArgumentException("Invalid numeric destination address");
        }
        return uri;
    }

    public static boolean isDemoTarget(URI uri, boolean demoMode, int port) {
        int targetPort = uri.getPort() == -1 ? 80 : uri.getPort();
        return demoMode && "http".equalsIgnoreCase(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
                && targetPort == port && uri.getRawQuery() == null && uri.getRawUserInfo() == null && uri.getRawFragment() == null
                && uri.getRawPath() != null && uri.getRawPath().matches("/api/demo/receiver/(good|flaky|reject|shop)");
    }

    public static String hostname(URI uri) {
        String hostname = uri.getHost();
        return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.substring(1, hostname.length() - 1) : hostname;
    }

    public static boolean isPublicAddress(InetAddress address) {
        byte[] bytes = address.getAddress();
        if (bytes.length == 16) {
            int first = bytes[0] & 255, second = bytes[1] & 255, third = bytes[2] & 255, fourth = bytes[3] & 255;
            return (first & 0xe0) == 0x20 // Global unicast 2000::/3 only.
                    && !(first == 0x20 && second == 1 && third == 0 && fourth == 0) // Teredo.
                    && !(first == 0x20 && second == 1 && third == 0x0d && fourth == 0xb8)
                    && !(first == 0x20 && second == 2); // 6to4.
        }
        if (bytes.length != 4) return false;
        int a = bytes[0] & 255, b = bytes[1] & 255, c = bytes[2] & 255;
        return !(a == 0 || a == 10 || a == 127 || a >= 224
                || (a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254)
                || (a == 172 && b >= 16 && b <= 31)
                || (a == 192 && (b == 168 || b == 0 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113));
    }

    private static IllegalArgumentException blocked() {
        return new IllegalArgumentException("Private, ambiguous and reserved network destinations are blocked");
    }
}
