package com.relayforge.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.relayforge.worker.WebhookSecurity;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.UriUtils;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.net.InetAddress;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class AccessFilter extends OncePerRequestFilter {
    private static final Set<String> PUBLIC = Set.of("/api/health", "/api/config", "/api/docs", "/api/openapi.json");
    private final String token;
    private final boolean demo;
    private final ObjectMapper mapper;
    private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();
    private record Bucket(long since, int count) {}

    public AccessFilter(@Value("${relay.api-token:}") String token, @Value("${relay.demo-mode:false}") boolean demo, ObjectMapper mapper) {
        if (token.length() < 32 || token.toLowerCase().matches("^(replace|change|your[-_]).*"))
            throw new IllegalStateException("API_TOKEN must be random and at least 32 characters; run npm run setup.");
        this.token = token;
        this.demo = demo;
        this.mapper = mapper;
    }

    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String rawPath=req.getRequestURI().substring(req.getContextPath().length());
        String decodedPath;
        try { decodedPath=UriUtils.decode(rawPath,StandardCharsets.UTF_8); }
        catch (IllegalArgumentException e) { reject(res,400,"BAD_REQUEST","Invalid request path"); return; }
        // Reject ambiguous path forms before Spring MVC or Tomcat can normalize them differently.
        if (rawPath.toLowerCase(java.util.Locale.ROOT).matches(".*%(2f|5c).*") || decodedPath.contains(";") || decodedPath.contains("\\") || decodedPath.contains("//") || java.util.Arrays.stream(decodedPath.split("/")).anyMatch(part->part.equals(".") || part.equals(".."))) {
            reject(res,400,"BAD_REQUEST","Ambiguous request path"); return;
        }
        String path = req.getServletPath();
        if (path == null || path.isEmpty()) path = decodedPath;
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
        if (path.startsWith("/api/") || path.startsWith("/receiver/")) res.setHeader("Cache-Control", "no-store");
        if (path.startsWith("/api/")) {
            long now=System.currentTimeMillis();
            if (buckets.size()>10000) buckets.entrySet().removeIf(e -> now-e.getValue().since()>60000);
            Bucket bucket=buckets.compute(req.getRemoteAddr(),(key,old)-> old==null || now-old.since()>=60000 ? new Bucket(now,1) : new Bucket(old.since(),old.count()+1));
            if (bucket.count()>300) { reject(res,429,"RATE_LIMITED","Too many requests. Try again in a minute."); return; }
        }
        if (path.startsWith("/receiver/")) {
            if (!demo || !InetAddress.getByName(req.getRemoteAddr()).isLoopbackAddress()) { reject(res, 404, "NOT_FOUND", "Route not found"); return; }
        } else if (path.startsWith("/api/") && !PUBLIC.contains(path) && !(demo && path.matches("/api/demo/receiver/(good|flaky|reject|shop)"))) {
            String auth = req.getHeader("Authorization");
            if (auth == null || !auth.startsWith("Bearer ") || !WebhookSecurity.tokensEqual(auth.substring(7), token)) {
                reject(res, 401, "UNAUTHORIZED", "A valid workspace API token is required"); return;
            }
        }
        if (req.getContentLengthLong()>65536) { reject(res,413,"PAYLOAD_TOO_LARGE","Request body exceeds 64 KiB"); return; }
        HttpServletRequest limited = new HttpServletRequestWrapper(req) {
            @Override public ServletInputStream getInputStream() throws IOException {
                ServletInputStream delegate=super.getInputStream();
                return new ServletInputStream() {
                    private long count;
                    @Override public int read() throws IOException { int value=delegate.read(); if(value!=-1 && ++count>65536) throw new IOException("Request body exceeds 64 KiB"); return value; }
                    @Override public boolean isFinished(){return delegate.isFinished();}
                    @Override public boolean isReady(){return delegate.isReady();}
                    @Override public void setReadListener(ReadListener listener){delegate.setReadListener(listener);}
                };
            }
        };
        chain.doFilter(limited, res);
    }

    private void reject(HttpServletResponse res, int status, String code, String message) throws IOException {
        res.setStatus(status); res.setContentType("application/json"); res.setCharacterEncoding("UTF-8");
        mapper.writeValue(res.getOutputStream(), Map.of("error", Map.of("code", code, "message", message)));
    }
}
