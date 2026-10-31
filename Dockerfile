FROM node:24-alpine AS dashboard
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.web.json vite.config.ts ./
COPY web ./web
COPY server/types.ts ./server/types.ts
RUN npm run build:web

FROM maven:3.9-eclipse-temurin-17 AS backend
WORKDIR /build
COPY java/pom.xml ./java/pom.xml
RUN mvn -B -ntp -f java/pom.xml dependency:go-offline
COPY java/src ./java/src
RUN mvn -B -ntp -f java/pom.xml package

FROM eclipse-temurin:17-jre-jammy AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/relayforge.sqlite \
    DEMO_MODE=false \
    WORKER_ENABLED=true
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 relayforge \
    && useradd --uid 10001 --gid relayforge --no-create-home --shell /usr/sbin/nologin relayforge \
    && mkdir -p /app/data && chown relayforge:relayforge /app/data
COPY --from=backend --chown=relayforge:relayforge /build/java/target/relayforge-2.0.0.jar ./relayforge.jar
COPY --from=dashboard --chown=relayforge:relayforge /build/dist/web ./dist/web
USER relayforge
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["java", "-jar", "/app/relayforge.jar"]
