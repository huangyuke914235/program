package com.relayforge.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.relayforge.store.RelayStore;
import com.relayforge.worker.WebhookSecurity;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import java.nio.file.Path;
import java.net.URI;
import java.util.Map;
import java.util.UUID;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ApiIntegrationTest {
    private static final String TOKEN="test-token-abcdefghijklmnopqrstuvwxyz0123456789";
    @DynamicPropertySource static void properties(DynamicPropertyRegistry registry) {
        registry.add("DATABASE_PATH",()->Path.of("target","api-"+UUID.randomUUID()+".sqlite").toAbsolutePath().toString());
        registry.add("API_TOKEN",()->TOKEN); registry.add("DEMO_MODE",()->"true"); registry.add("WORKER_ENABLED",()->"false");
    }
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired RelayStore store;
    private static final String AUTH="Bearer "+TOKEN;

    @Test void authValidationAndIdempotentCreation() throws Exception {
        mvc.perform(get("/api/stats")).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"));
        mvc.perform(get(URI.create("/%61pi/stats"))).andExpect(status().isUnauthorized());
        for(String path:new String[]{"/api;v=1/stats","/api/%2e%2e/api/stats","/api%2Fstats","/receiver;v=1/api/orders"})
            mvc.perform(get(URI.create(path))).andExpect(status().isBadRequest());
        mvc.perform(get("/api/config")).andExpect(status().isOk()).andExpect(jsonPath("$.demoMode").value(true));
        mvc.perform(get("/api/does-not-exist").header("Authorization",AUTH)).andExpect(status().isNotFound());
        mvc.perform(post("/api/stats").header("Authorization",AUTH)).andExpect(status().isMethodNotAllowed());
        mvc.perform(post("/api/endpoints").header("Authorization",AUTH).contentType(MediaType.APPLICATION_JSON).content("{\"name\":42,\"url\":\"https://example.com\"}"))
            .andExpect(status().isBadRequest());
        mvc.perform(post("/api/endpoints").header("Authorization",AUTH).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"Orders\",\"url\":\"https://example.com\",\"extra\":true}"))
            .andExpect(status().isBadRequest());
        mvc.perform(post("/api/endpoints").header("Authorization",AUTH).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"Bad\",\"url\":\"http://169.254.169.254/latest\"}"))
            .andExpect(status().isBadRequest());
        String response=mvc.perform(post("/api/endpoints").header("Authorization",AUTH).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"Orders\",\"url\":\"https://example.com/hooks\"}"))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        JsonNode endpoint=mapper.readTree(response);
        assertThat(endpoint.path("secret").asText()).startsWith("whsec_");
        String listed=mvc.perform(get("/api/endpoints").header("Authorization",AUTH)).andReturn().getResponse().getContentAsString();
        assertThat(listed).doesNotContain(endpoint.path("secret").asText());
        String payload=mapper.writeValueAsString(Map.of("type","order.created","payload",Map.of("orderId","ORD-42"),"endpointIds",new String[]{endpoint.path("id").asText()}));
        mvc.perform(post("/api/events").header("Authorization",AUTH).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isBadRequest());
        String key=UUID.randomUUID().toString();
        String first=mvc.perform(post("/api/events").header("Authorization",AUTH).header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(payload))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String duplicate=mvc.perform(post("/api/events").header("Authorization",AUTH).header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(payload))
            .andExpect(status().isOk()).andExpect(jsonPath("$.duplicate").value(true)).andReturn().getResponse().getContentAsString();
        assertThat(mapper.readTree(first).path("event").path("id")).isEqualTo(mapper.readTree(duplicate).path("event").path("id"));
        mvc.perform(post("/api/events").header("Authorization",AUTH).header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(payload.replace("ORD-42","ORD-43"))).andExpect(status().isConflict());
    }

    @Test void signedShopReceivesOnlyOnceAndRejectsTampering() throws Exception {
        String seeded=mvc.perform(post("/api/demo/bootstrap").header("Authorization",AUTH)).andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        JsonNode result=mapper.readTree(seeded);
        JsonNode delivery=null;
        for(JsonNode item:result.path("deliveries")) if(item.path("endpointUrl").asText().endsWith("/shop")) delivery=item;
        assertThat(delivery).isNotNull();
        String deliveryId=delivery.path("id").asText();
        var detail=store.getDelivery(deliveryId);
        String secret=store.getEndpointSecret(detail.delivery().endpointId());
        String body=mapper.writeValueAsString(Map.of("id",detail.event().id(),"type",detail.event().type(),"createdAt",detail.event().createdAt(),"data",detail.event().payload()));
        String timestamp=Long.toString(System.currentTimeMillis()/1000);
        String signature=WebhookSecurity.sign(body,timestamp,secret);
        mvc.perform(post("/api/demo/receiver/shop").contentType(MediaType.APPLICATION_JSON).content(body).header("webhook-delivery-id",deliveryId).header("webhook-id",detail.event().id()).header("webhook-timestamp",timestamp).header("webhook-signature","v1="+"0".repeat(64))).andExpect(status().isUnauthorized());
        for(int i=0;i<2;i++) mvc.perform(post("/api/demo/receiver/shop").contentType(MediaType.APPLICATION_JSON).content(body).header("webhook-delivery-id",deliveryId).header("webhook-id",detail.event().id()).header("webhook-timestamp",timestamp).header("webhook-signature",signature)).andExpect(status().isOk());
        String receipts=mvc.perform(get("/receiver/api/receipts")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(mapper.readTree(receipts).path("items").findValuesAsText("eventId").stream().filter(detail.event().id()::equals).count()).isEqualTo(1);
        mvc.perform(get("/receiver/api/orders")).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].orderId").value(detail.event().payload().path("orderId").asText()));
    }
}
