FROM golang:1.27-alpine AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

# Só `cmd/gateway/main.go` não basta: o binário é isolado em módulo próprio e
# main.go importa `pdv-ws-gateway/internal/...`. Sem copiar os dois, o build
# falha com "package pdv-ws-gateway/internal/auth is not in std".
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -o ws-gateway ./cmd/gateway/

FROM alpine:3.19

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /src/ws-gateway .

USER appuser

EXPOSE 8080

CMD ["./ws-gateway"]
