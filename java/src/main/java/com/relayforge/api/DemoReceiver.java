package com.relayforge.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.relayforge.store.Models.Detail;
import com.relayforge.store.RelayStore;
import com.relayforge.worker.WebhookSecurity;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import java.time.Instant;
import java.util.Map;

@RestController
public class DemoReceiver {
    private final RelayStore store;
    private final ObjectMapper mapper;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final boolean demo;
    private final int port;
    public DemoReceiver(RelayStore store,ObjectMapper mapper,JdbcTemplate jdbc,TransactionTemplate transaction,
                        @Value("${relay.demo-mode:false}") boolean demo,@Value("${server.port:3000}") int port) {
        this.store=store;this.mapper=mapper;this.jdbc=jdbc;this.transaction=transaction;this.demo=demo;this.port=port;
    }
    @PostConstruct void initialize() {
        jdbc.execute("CREATE TABLE IF NOT EXISTS demo_orders (orderId TEXT PRIMARY KEY,amount INTEGER NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL,updatedAt TEXT NOT NULL)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS demo_receipts (eventId TEXT NOT NULL, endpointId TEXT NOT NULL, eventType TEXT NOT NULL, deliveryId TEXT NOT NULL,receivedAt TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(eventId,endpointId))");
    }
    @PostMapping("/api/demo/receiver/{mode}") public ResponseEntity<?> receive(@PathVariable String mode,
        @RequestHeader(value="webhook-delivery-id",required=false) String deliveryId,
        @RequestHeader(value="webhook-id",required=false) String eventId,
        @RequestHeader(value="webhook-timestamp",required=false) String timestamp,
        @RequestHeader(value="webhook-signature",required=false) String signature,@RequestBody String body) throws Exception {
        if(!demo || !java.util.Set.of("good","flaky","reject","shop").contains(mode)) return ResponseEntity.notFound().build();
        Detail detail=deliveryId==null?null:store.getDelivery(deliveryId);
        String secret=detail==null?null:store.getEndpointSecret(detail.delivery().endpointId());
        if(detail==null || !detail.delivery().endpointUrl().equals("http://127.0.0.1:"+port+"/api/demo/receiver/"+mode)
            || !detail.event().id().equals(eventId) || secret==null || timestamp==null || signature==null
            || !WebhookSecurity.verifySignature(body,timestamp,signature,secret,System.currentTimeMillis())) {
            return ResponseEntity.status(401).body(Map.of("error",Map.of("code","INVALID_SIGNATURE","message","A valid webhook signature is required")));
        }
        if(mode.equals("reject")) return ResponseEntity.status(400).body(Map.of("error","Demo: permanent business validation failure"));
        if(mode.equals("flaky") && detail.delivery().attempts()<=2) return ResponseEntity.status(503).body(Map.of("error","Demo: temporarily unavailable; retry this request"));
        if(mode.equals("shop")) {
            JsonNode envelope=mapper.readTree(body), data=envelope.path("data");
            if(!detail.event().id().equals(envelope.path("id").asText()) || !"order.created".equals(envelope.path("type").asText()) || !data.path("orderId").isTextual()
                || data.path("orderId").asText().isBlank() || data.path("orderId").asText().length()>100 || !data.path("amount").isIntegralNumber() || !data.path("amount").canConvertToLong()
                || data.path("amount").asLong()<0 || !data.path("currency").asText().matches("[A-Z]{3}")) {
                return ResponseEntity.badRequest().body(Map.of("error","Expected order.created with orderId, non-negative amount, and currency"));
            }
            String now=Instant.now().toString();
            transaction.executeWithoutResult(status -> {
                int inserted=jdbc.update("INSERT OR IGNORE INTO demo_receipts(eventId,endpointId,eventType,deliveryId,receivedAt,outcome) VALUES(?,?,?,?,?,?)",
                    eventId,detail.delivery().endpointId(),detail.event().type(),deliveryId,now,"processed");
                if(inserted>0) jdbc.update("INSERT INTO demo_orders(orderId,amount,currency,status,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(orderId) DO UPDATE SET amount=excluded.amount,currency=excluded.currency,status=excluded.status,updatedAt=excluded.updatedAt",
                    data.path("orderId").asText(),data.path("amount").asLong(),data.path("currency").asText(),"received",now);
            });
        }
        return ResponseEntity.ok(Map.of("accepted",true,"eventId",detail.event().id()));
    }
    @GetMapping("/receiver/api/health") public Object health() { return Map.of("status","ok"); }
    @GetMapping("/receiver/api/orders") public Object orders() { return Map.of("items",jdbc.queryForList("SELECT orderId,amount,currency,status,updatedAt FROM demo_orders ORDER BY updatedAt DESC LIMIT 100")); }
    @GetMapping("/receiver/api/receipts") public Object receipts() { return Map.of("items",jdbc.queryForList("SELECT eventId,eventType,receivedAt,outcome,deliveryId FROM demo_receipts ORDER BY receivedAt DESC LIMIT 100")); }
}
