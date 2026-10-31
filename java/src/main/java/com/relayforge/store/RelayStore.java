package com.relayforge.store;

import static com.relayforge.store.Models.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeSet;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Repository;

/** SQLite transactional outbox. The write lock never spans an HTTP request. */
@Repository
public class RelayStore {
    private static final DateTimeFormatter ISO = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();
    private static final String DELIVERY_FIELDS = "d.id,d.eventId,d.endpointId,ev.type AS eventType,ep.name AS endpointName,d.endpointUrl,d.status,d.attempts,d.maxAttempts,d.nextAttemptAt,d.lastStatusCode,d.lastError,d.createdAt,d.updatedAt";
    private static final String DELIVERY_JOIN = " FROM deliveries d JOIN events ev ON ev.id=d.eventId JOIN endpoints ep ON ep.id=d.endpointId ";
    private final DataSource source;
    private final ObjectMapper mapper;
    private final SecureRandom random = new SecureRandom();

    public RelayStore(DataSource source, ObjectMapper mapper) {
        this.source = source;
        this.mapper = mapper;
        try (Connection c = connection(); Statement s = c.createStatement()) {
            try (ResultSet r = s.executeQuery("PRAGMA user_version")) {
                if (r.next() && r.getInt(1) > 1) throw new IllegalStateException("Database schema is newer than this application");
            }
            s.execute("PRAGMA journal_mode=WAL");
            s.execute("BEGIN IMMEDIATE");
            try {
                String sql;
                try (var in = new ClassPathResource("db/migration/V1__schema.sql").getInputStream()) {
                    sql = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                }
                for (String part : sql.split(";")) if (!part.isBlank()) s.execute(part.trim());
                s.execute("COMMIT");
            } catch (Exception e) { s.execute("ROLLBACK"); throw e; }
        } catch (Exception e) { throw new IllegalStateException("Cannot initialize SQLite database", e); }
    }
    private Connection connection() throws SQLException {
        Connection c = source.getConnection();
        try (Statement s = c.createStatement()) { s.execute("PRAGMA foreign_keys=ON"); s.execute("PRAGMA busy_timeout=5000"); s.execute("PRAGMA synchronous=FULL"); }
        catch (SQLException e) { c.close(); throw e; }
        return c;
    }
    @FunctionalInterface private interface Work<T> { T run(Connection c) throws Exception; }
    private <T> T read(Work<T> work) {
        try (Connection c = connection()) { return work.run(c); }
        catch (RuntimeException e) { throw e; }
        catch (Exception e) { throw new IllegalStateException("Database operation failed", e); }
    }
    private <T> T write(Work<T> work) {
        try (Connection c = connection(); Statement s = c.createStatement()) {
            s.execute("BEGIN IMMEDIATE");
            try { T result = work.run(c); s.execute("COMMIT"); return result; }
            catch (Exception e) { try { s.execute("ROLLBACK"); } catch (Exception rollback) { e.addSuppressed(rollback); } throw e; }
        } catch (RuntimeException e) { throw e; }
        catch (Exception e) { throw new IllegalStateException("Database transaction failed", e); }
    }
    private static String id(String prefix) { return prefix + "_" + UUID.randomUUID(); }
    private static String iso(long millis) { return ISO.format(Instant.ofEpochMilli(millis)); }
    private static String now() { return iso(System.currentTimeMillis()); }
    private static PreparedStatement prepare(Connection c, String sql, Object... args) throws SQLException {
        PreparedStatement p = c.prepareStatement(sql);
        for (int i = 0; i < args.length; i++) p.setObject(i + 1, args[i]);
        return p;
    }
    private static int execute(Connection c, String sql, Object... args) throws SQLException {
        try (PreparedStatement p = prepare(c, sql, args)) { return p.executeUpdate(); }
    }
    private static long count(Connection c, String sql, Object... args) throws SQLException {
        try (PreparedStatement p = prepare(c, sql, args); ResultSet r = p.executeQuery()) { return r.next() ? r.getLong(1) : 0; }
    }
    private void audit(Connection c, String action, String resourceId, String detail, String time) throws SQLException {
        execute(c, "INSERT INTO audit(id,action,resourceId,createdAt,detail) VALUES(?,?,?,?,?)", id("aud"),action,resourceId,time,detail);
    }
    private static Endpoint endpoint(ResultSet r) throws SQLException {
        return new Endpoint(r.getString("id"),r.getString("name"),r.getString("url"),r.getInt("enabled") != 0,r.getString("createdAt"));
    }
    private EventRecord event(ResultSet r) throws Exception {
        return new EventRecord(r.getString("id"),r.getString("type"),mapper.readTree(r.getString("payload")),r.getString("createdAt"),r.getString("idempotencyKey"));
    }
    private static Integer integer(ResultSet r, String field) throws SQLException { int n = r.getInt(field); return r.wasNull() ? null : n; }
    private static Long nullableLong(ResultSet r, String field) throws SQLException { long n = r.getLong(field); return r.wasNull() ? null : n; }
    private static Delivery delivery(ResultSet r) throws SQLException {
        return new Delivery(r.getString("id"),r.getString("eventId"),r.getString("endpointId"),r.getString("eventType"),r.getString("endpointName"),r.getString("endpointUrl"),r.getString("status"),r.getInt("attempts"),r.getInt("maxAttempts"),r.getString("nextAttemptAt"),integer(r,"lastStatusCode"),r.getString("lastError"),r.getString("createdAt"),r.getString("updatedAt"));
    }
    private static Attempt attempt(ResultSet r) throws SQLException {
        return new Attempt(r.getString("id"),r.getString("deliveryId"),r.getInt("number"),r.getString("startedAt"),r.getString("finishedAt"),integer(r,"statusCode"),nullableLong(r,"durationMs"),r.getString("error"),r.getString("responseBody"));
    }
    private List<Endpoint> endpoints(Connection c) throws SQLException {
        List<Endpoint> items = new ArrayList<>();
        try (PreparedStatement p = prepare(c,"SELECT id,name,url,enabled,createdAt FROM endpoints ORDER BY createdAt DESC,id"); ResultSet r = p.executeQuery()) { while (r.next()) items.add(endpoint(r)); }
        return items;
    }
    public List<Endpoint> listEndpoints() { return read(this::endpoints); }
    public CreatedEndpoint createEndpoint(String name, String url) {
        byte[] bytes = new byte[32]; random.nextBytes(bytes);
        String secret = "whsec_" + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        String id = id("ep"), time = now();
        return write(c -> {
            execute(c,"INSERT INTO endpoints(id,name,url,enabled,secret,createdAt) VALUES(?,?,?,1,?,?)",id,name,url,secret,time);
            audit(c,"endpoint.created",id,name,time);
            return new CreatedEndpoint(id,name,url,true,time,secret);
        });
    }
    public Endpoint setEndpointEnabled(String id, boolean enabled) {
        return write(c -> {
            if (execute(c,"UPDATE endpoints SET enabled=? WHERE id=?", enabled ? 1 : 0,id)==0) return null;
            Endpoint item;
            try (PreparedStatement p=prepare(c,"SELECT id,name,url,enabled,createdAt FROM endpoints WHERE id=?",id); ResultSet r=p.executeQuery()) { item=r.next()?endpoint(r):null; }
            audit(c,enabled ? "endpoint.resumed" : "endpoint.paused",id,Objects.requireNonNull(item).name(),now());
            return item;
        });
    }
    private String secret(Connection c,String id) throws SQLException {
        try (PreparedStatement p=prepare(c,"SELECT secret FROM endpoints WHERE id=?",id);ResultSet r=p.executeQuery()) { return r.next()?r.getString(1):null; }
    }
    public String getEndpointSecret(String id) { return read(c -> secret(c,id)); }
    private EventRecord eventById(Connection c,String id) throws Exception {
        try (PreparedStatement p=prepare(c,"SELECT * FROM events WHERE id=?",id);ResultSet r=p.executeQuery()) { return r.next()?event(r):null; }
    }
    public EventRecord getEvent(String id) { return read(c -> eventById(c,id)); }
    public List<EventRecord> listEvents() { return listEvents(50); }
    public List<EventRecord> listEvents(int limit) { return read(c -> {
        List<EventRecord> items=new ArrayList<>();
        try (PreparedStatement p=prepare(c,"SELECT * FROM events ORDER BY createdAt DESC,id LIMIT ?",limit);ResultSet r=p.executeQuery()) { while(r.next()) items.add(event(r)); }
        return items;
    }); }
    private String canonical(JsonNode node) throws Exception {
        if (node.isObject()) {
            TreeSet<String> keys=new TreeSet<>(); node.fieldNames().forEachRemaining(keys::add);
            List<String> fields=new ArrayList<>();
            for(String key:keys) fields.add(jsString(key)+":"+canonical(node.get(key)));
            return "{"+String.join(",",fields)+"}";
        }
        if(node.isArray()) {
            List<String> values=new ArrayList<>(); for(JsonNode value:node) values.add(canonical(value));
            return "["+String.join(",",values)+"]";
        }
        if(node.isNumber()) {
            // JSON.parse/JSON.stringify in the Node implementation uses IEEE-754 doubles.
            double value=node.doubleValue();
            if(!Double.isFinite(value)) return "null";
            if(value==0) return "0";
            BigDecimal exact=new BigDecimal(value), decimal=null;
            // Find the shortest decimal that maps back to the identical IEEE-754 value.
            for(int digits=1;digits<=17;digits++) {
                BigDecimal candidate=exact.round(new MathContext(digits,RoundingMode.HALF_EVEN)).stripTrailingZeros();
                if(Double.doubleToRawLongBits(candidate.doubleValue())==Double.doubleToRawLongBits(value)) { decimal=candidate; break; }
            }
            if(decimal==null) throw new IllegalStateException("Cannot encode JSON number");
            if(Math.abs(value)>=1e-6 && Math.abs(value)<1e21) return decimal.toPlainString();
            String scientific=decimal.toString().replace('E','e');
            int e=scientific.indexOf('e');
            if(e<0) return scientific;
            String exponent=scientific.substring(e+1);
            if(!exponent.startsWith("-") && !exponent.startsWith("+")) exponent="+"+exponent;
            return scientific.substring(0,e+1)+exponent;
        }
        return node.isTextual() ? jsString(node.textValue()) : node.toString();
    }
    private static String jsString(String value) {
        StringBuilder out=new StringBuilder("\"");
        for(int i=0;i<value.length();i++) {
            char ch=value.charAt(i);
            switch(ch) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if(ch<32 || (Character.isHighSurrogate(ch) && (i+1>=value.length() || !Character.isLowSurrogate(value.charAt(i+1)))) || (Character.isLowSurrogate(ch) && (i==0 || !Character.isHighSurrogate(value.charAt(i-1))))) out.append(String.format("\\u%04x",(int)ch));
                    else out.append(ch);
                }
            }
        }
        return out.append('"').toString();
    }
    private String fingerprint(String type,JsonNode payload,List<String> endpointIds) throws Exception {
        ObjectNode object=mapper.createObjectNode(); object.put("type",type); object.set("payload",payload);
        if(endpointIds==null) object.put("endpointIds","*"); else object.set("endpointIds",mapper.valueToTree(endpointIds));
        object.put("maxAttempts",5);
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical(object).getBytes(StandardCharsets.UTF_8)));
    }
    public SubmitResult submitEvent(String type, JsonNode payload, List<String> ids, String key) {
        List<String> targetIds=ids==null?null:List.copyOf(new TreeSet<>(ids));
        return write(c -> {
            String hash=fingerprint(type,payload,targetIds);
            try (PreparedStatement p=prepare(c,"SELECT * FROM events WHERE idempotencyKey=?",key);ResultSet r=p.executeQuery()) {
                if(r.next()) {
                    if(!hash.equals(r.getString("requestHash"))) throw new DomainException("IDEMPOTENCY_CONFLICT","This idempotency key was already used for a different event");
                    EventRecord prior=event(r); return new SubmitResult(prior, deliveries(c,null,prior.id(),1000,0).items(),true);
                }
            }
            List<Endpoint> targets=endpoints(c).stream().filter(e -> e.enabled() && (targetIds==null || targetIds.contains(e.id()))).toList();
            if(targets.isEmpty() || (targetIds!=null && targets.size()!=targetIds.size())) throw new DomainException("INVALID_ENDPOINTS","Select at least one enabled endpoint");
            String time=now(), eventId=id("evt");
            execute(c,"INSERT INTO events(id,type,payload,idempotencyKey,requestHash,createdAt) VALUES(?,?,?,?,?,?)",eventId,type,mapper.writeValueAsString(payload),key,hash,time);
            for(Endpoint ep:targets) execute(c,"INSERT INTO deliveries(id,eventId,endpointId,endpointUrl,status,attempts,maxAttempts,nextAttemptAt,createdAt,updatedAt) VALUES(?,?,?,?,'pending',0,5,?,?,?)",id("dlv"),eventId,ep.id(),ep.url(),time,time,time);
            audit(c,"event.accepted",eventId,type+": "+targets.size()+" delivery target(s)",time);
            return new SubmitResult(new EventRecord(eventId,type,payload,time,key),deliveries(c,null,eventId,1000,0).items(),false);
        });
    }
    private DeliveryPage deliveries(Connection c,String status,String eventId,int limit,int offset) throws SQLException {
        String where=" WHERE 1=1"; List<Object> args=new ArrayList<>();
        if(status!=null && !status.isBlank()) {where+=" AND d.status=?";args.add(status);}
        if(eventId!=null && !eventId.isBlank()) {where+=" AND d.eventId=?";args.add(eventId);}
        long total=count(c,"SELECT COUNT(*) FROM deliveries d"+where,args.toArray());
        args.add(limit);args.add(offset); List<Delivery> result=new ArrayList<>();
        try(PreparedStatement p=prepare(c,"SELECT "+DELIVERY_FIELDS+DELIVERY_JOIN+where+" ORDER BY d.createdAt DESC,d.id LIMIT ? OFFSET ?",args.toArray());ResultSet r=p.executeQuery()) {while(r.next()) result.add(delivery(r));}
        return new DeliveryPage(result,total);
    }
    public DeliveryPage listDeliveries(String status,String eventId,int limit,int offset) { return read(c -> deliveries(c,status,eventId,limit,offset)); }
    private Detail detail(Connection c,String id) throws Exception {
        Delivery d;
        try(PreparedStatement p=prepare(c,"SELECT "+DELIVERY_FIELDS+DELIVERY_JOIN+" WHERE d.id=?",id);ResultSet r=p.executeQuery()) { if(!r.next()) return null; d=delivery(r); }
        List<Attempt> attempts=new ArrayList<>();
        try(PreparedStatement p=prepare(c,"SELECT * FROM attempts WHERE deliveryId=? ORDER BY number DESC",id);ResultSet r=p.executeQuery()) {while(r.next()) attempts.add(attempt(r));}
        return new Detail(d,eventById(c,d.eventId()),attempts);
    }
    public Detail getDelivery(String id) { return read(c -> detail(c,id)); }
    public Delivery retryDelivery(String id) { return write(c -> {
        Detail current=detail(c,id); if(current==null) return null;
        if(!List.of("dead","delivered").contains(current.delivery().status())) throw new DomainException("DELIVERY_BUSY","Only delivered or dead deliveries can be replayed");
        String time=now(); execute(c,"UPDATE deliveries SET status='pending',attempts=0,nextAttemptAt=?,lastStatusCode=NULL,lastError=NULL,leaseToken=NULL,leaseExpiresAt=NULL,activeAttemptId=NULL,updatedAt=? WHERE id=?",time,time,id);
        audit(c,"delivery.replayed",id,"Queued a new retry round; attempt history retained.",time); return Objects.requireNonNull(detail(c,id)).delivery();
    }); }
    public List<AuditEntry> audit() { return read(c -> {
        List<AuditEntry> items=new ArrayList<>();
        try(PreparedStatement p=prepare(c,"SELECT * FROM audit ORDER BY createdAt DESC,rowid DESC LIMIT 30");ResultSet r=p.executeQuery()) {while(r.next()) items.add(new AuditEntry(r.getString("id"),r.getString("action"),r.getString("resourceId"),r.getString("createdAt"),r.getString("detail")));} return items;
    }); }
    public DashboardStats stats() { return read(c -> {
        Map<String,Long> counts=new LinkedHashMap<>();
        try(PreparedStatement p=prepare(c,"SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status");ResultSet r=p.executeQuery()) {while(r.next()) counts.put(r.getString("status"),r.getLong("count"));}
        long total=counts.values().stream().mapToLong(Long::longValue).sum(), delivered=counts.getOrDefault("delivered",0L);
        long currentHour=System.currentTimeMillis()/3600000*3600000,start=currentHour-23*3600000;
        Map<String,Hour> bins=new LinkedHashMap<>(); for(long hour=start;hour<=currentHour;hour+=3600000) bins.put(iso(hour),new Hour(iso(hour),0,0));
        try(PreparedStatement p=prepare(c,"SELECT substr(finishedAt,1,13)||':00:00.000Z' AS hour,SUM(CASE WHEN statusCode BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS delivered,SUM(CASE WHEN statusCode BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS failed FROM attempts WHERE finishedAt>=? GROUP BY hour",iso(start));ResultSet r=p.executeQuery()) {while(r.next()) {String h=r.getString("hour");if(bins.containsKey(h))bins.put(h,new Hour(h,r.getLong("delivered"),r.getLong("failed")));}}
        return new DashboardStats(count(c,"SELECT COUNT(*) FROM endpoints"),count(c,"SELECT COUNT(*) FROM events"),total,delivered,counts.getOrDefault("pending",0L),counts.getOrDefault("processing",0L),counts.getOrDefault("retrying",0L),counts.getOrDefault("dead",0L),total==0?0:Math.round((double)delivered/total*1000)/10.0,List.copyOf(bins.values()));
    }); }
    public Claim claimDelivery(long nowMs,long leaseMs) { return write(c -> {
        String time=iso(nowMs), error="Worker lease expired before completion; delivery outcome is unknown.";
        record Expired(String id,String attemptId,int attempts,int maxAttempts,String startedAt) {}
        List<Expired> expired=new ArrayList<>();
        try(PreparedStatement p=prepare(c,"SELECT d.id,d.activeAttemptId,d.attempts,d.maxAttempts,a.startedAt FROM deliveries d LEFT JOIN attempts a ON a.id=d.activeAttemptId WHERE d.status='processing' AND d.leaseExpiresAt<=?",time);ResultSet r=p.executeQuery()) {while(r.next()) expired.add(new Expired(r.getString("id"),r.getString("activeAttemptId"),r.getInt("attempts"),r.getInt("maxAttempts"),r.getString("startedAt")));}
        for(Expired e:expired) {
            if(e.startedAt()!=null) execute(c,"UPDATE attempts SET finishedAt=?,durationMs=?,error=? WHERE id=? AND finishedAt IS NULL",time,Math.max(0,nowMs-Instant.parse(e.startedAt()).toEpochMilli()),error,e.attemptId());
            boolean dead=e.attempts()>=e.maxAttempts();
            execute(c,"UPDATE deliveries SET status=?,nextAttemptAt=?,lastStatusCode=NULL,lastError=?,leaseToken=NULL,leaseExpiresAt=NULL,activeAttemptId=NULL,updatedAt=? WHERE id=?",dead?"dead":"retrying",dead?null:time,error,time,e.id());
            audit(c,dead?"delivery.dead":"delivery.recovered",e.id(),error,time);
        }
        Delivery selected;
        try(PreparedStatement p=prepare(c,"SELECT "+DELIVERY_FIELDS+DELIVERY_JOIN+" WHERE d.status IN ('pending','retrying') AND d.nextAttemptAt<=? AND ep.enabled=1 ORDER BY d.nextAttemptAt,d.createdAt,d.id LIMIT 1",time);ResultSet r=p.executeQuery()) {if(!r.next())return null;selected=delivery(r);}
        String token=UUID.randomUUID().toString(), attemptId=id("att");
        long number=count(c,"SELECT COALESCE(MAX(number),0)+1 FROM attempts WHERE deliveryId=?",selected.id());
        execute(c,"INSERT INTO attempts(id,deliveryId,number,startedAt) VALUES(?,?,?,?)",attemptId,selected.id(),number,time);
        execute(c,"UPDATE deliveries SET status='processing',attempts=attempts+1,nextAttemptAt=NULL,leaseToken=?,leaseExpiresAt=?,activeAttemptId=?,updatedAt=? WHERE id=?",token,iso(nowMs+leaseMs),attemptId,time,selected.id());
        Detail d=Objects.requireNonNull(detail(c,selected.id())); return new Claim(d.delivery(),d.event(),secret(c,selected.endpointId()),token,attemptId,nowMs);
    }); }
    public boolean completeDelivery(Claim claim,Outcome outcome) { return write(c -> {
        String time=iso(outcome.nowMs()); int attempts,max;
        try(PreparedStatement p=prepare(c,"SELECT attempts,maxAttempts FROM deliveries WHERE id=? AND status='processing' AND leaseToken=? AND leaseExpiresAt>?",claim.delivery().id(),claim.token(),time);ResultSet r=p.executeQuery()) {if(!r.next())return false;attempts=r.getInt("attempts");max=r.getInt("maxAttempts");}
        boolean retrying=!outcome.success() && outcome.retryable() && attempts<max;
        String status=outcome.success()?"delivered":retrying?"retrying":"dead";
        execute(c,"UPDATE attempts SET finishedAt=?,statusCode=?,durationMs=?,error=?,responseBody=? WHERE id=?",time,outcome.statusCode(),Math.max(0,outcome.nowMs()-claim.startedAt()),outcome.error(),outcome.responseBody(),claim.attemptId());
        execute(c,"UPDATE deliveries SET status=?,nextAttemptAt=?,lastStatusCode=?,lastError=?,leaseToken=NULL,leaseExpiresAt=NULL,activeAttemptId=NULL,updatedAt=? WHERE id=?",status,retrying?iso(outcome.nowMs()+outcome.retryDelayMs()):null,outcome.statusCode(),outcome.error(),time,claim.delivery().id());
        audit(c,"delivery."+status,claim.delivery().id(),outcome.success()?"HTTP "+outcome.statusCode():(outcome.error()!=null?outcome.error():"HTTP "+outcome.statusCode()),time);
        return true;
    }); }
}
