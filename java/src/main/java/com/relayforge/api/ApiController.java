package com.relayforge.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.relayforge.store.DomainException;
import com.relayforge.store.Models.*;
import com.relayforge.store.RelayStore;
import com.relayforge.worker.WebhookSecurity;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api")
public class ApiController {
    private final RelayStore store;
    private final ObjectMapper mapper;
    private final boolean demo;
    private final int port;
    private final JdbcTemplate jdbc;
    public ApiController(RelayStore store, ObjectMapper mapper, JdbcTemplate jdbc, @Value("${relay.demo-mode:false}") boolean demo, @Value("${server.port:3000}") int port) {
        this.store=store; this.mapper=mapper; this.jdbc=jdbc; this.demo=demo; this.port=port;
    }
    public record EndpointRequest(@NotBlank @Size(max=80) String name, @NotBlank @Size(max=2048) String url) {}
    public record ToggleRequest(@NotNull Boolean enabled) {}
    public record EventRequest(@NotBlank @Size(max=100) @Pattern(regexp="[a-zA-Z0-9_.-]+") String type,
                               @NotNull JsonNode payload, @Size(min=1,max=100) List<@NotBlank @Size(max=80) String> endpointIds) {}

    @GetMapping("/health") public Object health() { jdbc.queryForObject("SELECT 1",Integer.class); return Map.of("status", "ok", "version", "2.0.0"); }
    @GetMapping("/config") public Object config() { return Map.of("demoMode", demo); }
    @GetMapping("/stats") public Object stats() { return store.stats(); }
    @GetMapping("/audit") public Object audit() { return Map.of("items",store.audit()); }
    @GetMapping("/endpoints") public Object endpoints() { return Map.of("items",store.listEndpoints()); }
    @PostMapping("/endpoints") public ResponseEntity<?> create(@Valid @RequestBody EndpointRequest body) {
        final String url;
        try { url=WebhookSecurity.validateTarget(body.url(), demo, port).toASCIIString(); }
        catch (IllegalArgumentException e) { throw new DomainException("INVALID_URL",e.getMessage()); }
        return ResponseEntity.status(HttpStatus.CREATED).body(store.createEndpoint(body.name().trim(),url));
    }
    @PatchMapping("/endpoints/{id}") public Object toggle(@PathVariable String id,@Valid @RequestBody ToggleRequest body) {
        Endpoint result=store.setEndpointEnabled(id,body.enabled()); if(result==null) throw missing(); return result;
    }
    @GetMapping("/events") public Object events() { return Map.of("items",store.listEvents()); }
    @PostMapping("/events") public ResponseEntity<?> submit(@RequestHeader(value="Idempotency-Key",required=false) String key,@Valid @RequestBody EventRequest body) {
        if(key==null || !key.matches("[\\x21-\\x7e]{1,128}")) throw new DomainException("IDEMPOTENCY_KEY_REQUIRED","Provide an Idempotency-Key header (1–128 visible ASCII characters)");
        if(!body.payload().isObject()) throw new DomainException("VALIDATION_ERROR","payload must be a JSON object");
        if(body.endpointIds()!=null && new HashSet<>(body.endpointIds()).size()!=body.endpointIds().size()) throw new DomainException("VALIDATION_ERROR","endpointIds must be unique");
        SubmitResult result=store.submitEvent(body.type(),body.payload(),body.endpointIds(),key);
        return ResponseEntity.status(result.duplicate()?HttpStatus.OK:HttpStatus.CREATED).body(result);
    }
    @GetMapping("/deliveries") public Object deliveries(@RequestParam(required=false) String status,@RequestParam(required=false) String eventId,
        @RequestParam(defaultValue="50") int limit,@RequestParam(defaultValue="0") int offset) {
        if((status!=null && !Set.of("pending","processing","retrying","delivered","dead").contains(status)) || limit<1 || limit>100 || offset<0 || offset>1000000 || (eventId!=null && eventId.length()>80))
            throw new DomainException("VALIDATION_ERROR","Invalid delivery filters or pagination");
        return store.listDeliveries(status,eventId,limit,offset);
    }
    @GetMapping("/deliveries/{id}") public Object detail(@PathVariable String id) { Detail result=store.getDelivery(id); if(result==null) throw missing(); return result; }
    @PostMapping("/deliveries/{id}/retry") public Object retry(@PathVariable String id) { Delivery result=store.retryDelivery(id); if(result==null) throw missing(); return result; }
    @PostMapping("/demo/bootstrap") public ResponseEntity<?> bootstrap() {
        if(!demo) throw missing();
        List<Endpoint> existing=store.listEndpoints();
        List<Endpoint> endpoints=new ArrayList<>();
        for(String mode:List.of("good","flaky","reject","shop")) {
            String url="http://127.0.0.1:"+port+"/api/demo/receiver/"+mode;
            Endpoint found=existing.stream().filter(e->e.url().equals(url)).findFirst().orElse(null);
            if(found!=null) endpoints.add(store.setEndpointEnabled(found.id(),true));
            else { CreatedEndpoint created=store.createEndpoint(switch(mode){case "good"->"订单服务 · 正常响应";case "flaky"->"通知服务 · 失败后恢复";case "reject"->"风控服务 · 拒绝请求";default->"Vue 订单工作台";},url);
                endpoints.add(new Endpoint(created.id(),created.name(),created.url(),created.enabled(),created.createdAt())); }
        }
        JsonNode payload=mapper.valueToTree(Map.of("orderId","ORD-"+System.currentTimeMillis(),"amount",29900,"currency","CNY","customer","Demo Customer"));
        SubmitResult result=store.submitEvent("order.created",payload,endpoints.stream().map(Endpoint::id).toList(),UUID.randomUUID().toString());
        return ResponseEntity.status(201).body(Map.of("event",result.event(),"deliveries",result.deliveries(),"endpoints",endpoints));
    }
    private static DomainException missing() { return new DomainException("NOT_FOUND","Resource not found"); }
}
