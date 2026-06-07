# syntax=docker/dockerfile:1

FROM node:26-alpine3.23 AS frontend-builder
WORKDIR /src/frontend

COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

FROM golang:1.26-alpine3.23 AS backend-builder
WORKDIR /src

COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/openlist-clipboard ./cmd/server

FROM alpine:3.23
WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata

COPY --from=backend-builder /out/openlist-clipboard /usr/local/bin/openlist-clipboard
COPY --from=frontend-builder /src/frontend/dist ./frontend/dist

ENV CLIPBOARD_ADDR=:8080
ENV CLIPBOARD_STATIC_DIR=/app/frontend/dist

EXPOSE 8080

USER 65532:65532

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["openlist-clipboard"]
