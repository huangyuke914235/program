package com.relayforge.worker;

import java.io.IOException;
import java.util.Map;

/** A single HTTP exchange. Application retries belong to DeliveryWorker, never the HTTP client. */
@FunctionalInterface
public interface Transport {
    Response send(Request request) throws IOException;

    record Request(String url, String body, Map<String, String> headers) {}
    record Response(int statusCode, String body) {}
}
