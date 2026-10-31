package com.relayforge.api;

import com.relayforge.store.DomainException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import java.util.Map;

@RestControllerAdvice
public class ApiErrors {
    private static final Logger LOG=LoggerFactory.getLogger(ApiErrors.class);
    @ExceptionHandler(DomainException.class) ResponseEntity<?> domain(DomainException e) {
        int status=switch(e.code()){case "NOT_FOUND"->404;case "IDEMPOTENCY_CONFLICT","DELIVERY_BUSY"->409;default->400;};
        return error(status,e.code(),e.getMessage());
    }
    @ExceptionHandler({MethodArgumentNotValidException.class,HttpMessageNotReadableException.class,MethodArgumentTypeMismatchException.class})
    ResponseEntity<?> invalid(Exception e) { return error(400,"VALIDATION_ERROR","Invalid request body or parameters"); }
    @ExceptionHandler(NoResourceFoundException.class) ResponseEntity<?> notFound(Exception e) { return error(404,"NOT_FOUND","Route not found"); }
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class) ResponseEntity<?> methodNotAllowed(Exception e) { return error(405,"METHOD_NOT_ALLOWED","Method not allowed"); }
    @ExceptionHandler(Exception.class) ResponseEntity<?> unexpected(Exception e) { LOG.error("Request failed",e); return error(500,"INTERNAL_ERROR","The request could not be completed"); }
    private ResponseEntity<?> error(int status,String code,String message) { return ResponseEntity.status(status).body(Map.of("error",Map.of("code",code,"message",message))); }
}
