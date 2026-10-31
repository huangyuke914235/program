package com.relayforge;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.sqlite.SQLiteDataSource;
import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import com.fasterxml.jackson.databind.cfg.CoercionAction;
import com.fasterxml.jackson.databind.cfg.CoercionInputShape;
import com.fasterxml.jackson.databind.type.LogicalType;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;

@SpringBootApplication
@EnableScheduling
public class RelayForgeApplication {
    public static void main(String[] args) {
        SpringApplication.run(RelayForgeApplication.class, args);
    }

    @Bean
    DataSource dataSource(@Value("${DATABASE_PATH:data/relayforge.sqlite}") String databasePath) throws Exception {
        if (databasePath.equals(":memory:")) throw new IllegalArgumentException("Use a SQLite file: in-memory databases are not shared between connections");
        Path parent = Path.of(databasePath).toAbsolutePath().normalize().getParent();
        if (parent != null) Files.createDirectories(parent);
        SQLiteDataSource source = new SQLiteDataSource();
        source.setUrl("jdbc:sqlite:" + databasePath);
        return source;
    }

    @Bean
    Jackson2ObjectMapperBuilderCustomizer strictStrings() {
        return builder -> builder.postConfigurer(mapper -> {
            var rules=mapper.coercionConfigFor(LogicalType.Textual);
            rules.setCoercion(CoercionInputShape.Integer,CoercionAction.Fail);
            rules.setCoercion(CoercionInputShape.Float,CoercionAction.Fail);
            rules.setCoercion(CoercionInputShape.Boolean,CoercionAction.Fail);
        });
    }
}
