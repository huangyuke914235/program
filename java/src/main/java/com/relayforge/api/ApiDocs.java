package com.relayforge.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import java.io.IOException;

@RestController
public class ApiDocs {
    private final ObjectMapper mapper;
    public ApiDocs(ObjectMapper mapper) { this.mapper=mapper; }
    @GetMapping("/api/openapi.json") public JsonNode openapi() throws IOException {
        return mapper.readTree(new ClassPathResource("openapi.json").getInputStream());
    }
    @GetMapping(value="/api/docs",produces=MediaType.TEXT_HTML_VALUE) public String docs() {
        return """
            <!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RelayForge API</title>
            <style>body{background:#101217;color:#ddd;font:16px/1.8 system-ui;max-width:900px;margin:60px auto;padding:24px}a{color:#ff9c68}code{background:#20242c;padding:5px;border-radius:4px}li{margin:14px 0}</style>
            <h1>RelayForge API</h1><p>可靠 Webhook 投递平台 · Spring Boot</p>
            <p>管理请求携带 <code>Authorization: Bearer &lt;API_TOKEN&gt;</code>，事件提交还需要 <code>Idempotency-Key</code>。</p>
            <p><a href="/api/openapi.json">OpenAPI 3.0 文档</a> · <a href="/">管理控制台</a></p>
            <ul><li><code>GET /api/endpoints</code> 查询端点</li><li><code>POST /api/endpoints</code> 创建端点</li><li><code>POST /api/events</code> 提交事件</li><li><code>GET /api/deliveries</code> 查询投递</li><li><code>GET /api/deliveries/{id}</code> 查看尝试记录</li><li><code>POST /api/deliveries/{id}/retry</code> 重放</li></ul>
            <p>接收端使用端点密钥计算 HMAC-SHA256(timestamp + '.' + 原始请求体)，校验时间戳并按事件 ID 去重。</p></html>
            """;
    }
}
