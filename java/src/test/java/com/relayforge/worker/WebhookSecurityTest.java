package com.relayforge.worker;

import static org.junit.jupiter.api.Assertions.*;
import java.net.InetAddress;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class WebhookSecurityTest {
    @Test
    void signaturesMatchTheExistingNodeWireProtocolAndRejectTamperingOrReplay() {
        String body = "{\"id\":\"evt-1\",\"data\":{\"amount\":42}}";
        String expected = "v1=207eec4c88dac8574554c477fecc32754fcefe0a0816147a49b3ebdb9b2b3331";
        assertEquals(expected, WebhookSecurity.sign(body, "1700000000", "whsec_test"));
        assertTrue(WebhookSecurity.verifySignature(body, "1700000000", expected, "whsec_test", 1700000000000L));
        assertFalse(WebhookSecurity.verifySignature(body + " ", "1700000000", expected, "whsec_test", 1700000000000L));
        assertFalse(WebhookSecurity.verifySignature(body, "1700000000", expected, "whsec_test", 1700000301000L));
        assertFalse(WebhookSecurity.verifySignature(body, "1700000000", expected, "whsec_test", 1699999699000L));
        assertFalse(WebhookSecurity.verifySignature(body, "Infinity", expected, "whsec_test", 1700000000000L));
        assertFalse(WebhookSecurity.verifySignature(body, "1700000000", "v1=bad", "whsec_test", 1700000000000L));
        assertTrue(WebhookSecurity.tokensEqual("a", "a"));
        assertFalse(WebhookSecurity.tokensEqual("a", "b"));
        assertFalse(WebhookSecurity.tokensEqual(null, "b"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"127.0.0.1", "10.1.2.3", "169.254.169.254", "172.31.0.1", "192.168.1.1", "0.0.0.0", "100.64.1.1", "192.0.0.1", "198.18.0.1", "198.51.100.3", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "2001::1"})
    void privateReservedAndTunnelAddressesAreBlocked(String address) throws Exception {
        assertFalse(WebhookSecurity.isPublicAddress(InetAddress.getByName(address)), address);
    }

    @ParameterizedTest
    @ValueSource(strings = {"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"})
    void publicAddressesAreAllowed(String address) throws Exception {
        assertTrue(WebhookSecurity.isPublicAddress(InetAddress.getByName(address)), address);
    }

    @ParameterizedTest
    @ValueSource(strings = {"file:///etc/passwd", "ftp://example.com", "http://user:pass@example.com", "https://example.com/#token", "http://127.1", "http://2130706433", "http://0x7f000001", "http://127.00.0.1", "http://[::1]", "http://[::ffff:8.8.8.8]", "http://localhost", "http://test.localhost", "http://localhost.", "http://192.168.0.1", "https://example.com:65536"})
    void unsafeUrlsAndAmbiguousAddressFormatsAreRejected(String url) {
        assertThrows(IllegalArgumentException.class, () -> WebhookSecurity.validateTarget(url, false, 3000), url);
    }

    @Test
    void theDemoExceptionIsLimitedToExactReceiverPathsOnTheConfiguredPort() {
        for (String mode : new String[] {"good", "flaky", "reject", "shop"}) {
            String target = "http://127.0.0.1:3000/api/demo/receiver/" + mode;
            assertEquals(target, WebhookSecurity.validateTarget(target, true, 3000).toString());
            assertThrows(IllegalArgumentException.class, () -> WebhookSecurity.validateTarget(target, false, 3000));
        }
        for (String url : new String[] {"http://127.0.0.1:3001/api/demo/receiver/shop", "http://127.0.0.1:3000/api/health", "http://127.0.0.1:3000/api/demo/receiver/shop?x=1", "http://127.0.0.1:3000/api/demo/receiver/%73hop", "http://127.0.0.1:3000/api/demo/receiver/shop/", "http://localhost:3000/api/demo/receiver/shop"}) {
            assertThrows(IllegalArgumentException.class, () -> WebhookSecurity.validateTarget(url, true, 3000), url);
        }
    }
}
