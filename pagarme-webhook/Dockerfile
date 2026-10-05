# Multi-stage, igual ao `ws-gateway/Dockerfile` (que é o precedente do repo):
# a imagem final tem só o binário estático e o alpine, sem toolchain de Go.
FROM golang:1.27-alpine AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

# Só `cmd/webhook/main.go` não basta: o binário é isolado em módulo próprio e
# main.go importa `pdv-pagarme-webhook/internal/...`. Sem copiar os dois, o build
# falha com "package pdv-pagarme-webhook/internal/db is not in std".
COPY cmd/ ./cmd/
COPY internal/ ./internal/
# CGO_ENABLED=0: o binário fica estático e roda em alpine sem libc de Go. A única
# dependência é o lib/pq, que é Go puro — não há bindings de C para ligar.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o pagarme-webhook ./cmd/webhook/

FROM alpine:3.19

WORKDIR /app

# wget vem do busybox e é o que o healthcheck usa (a imagem não tem curl).
# ca-certificates é para a chamada HTTPS ao Pagar.me e ao backend Node: sem ele, o
# TLS falha com "x509: certificate signed by unknown authority" e o webhook
# responde 200 sem gravar nada — porque o drain engole o erro e o evento só reaparece
# na reconciliação.
RUN apk add --no-cache ca-certificates \
 && addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /src/pagarme-webhook .

USER appuser

EXPOSE 8080

CMD ["./pagarme-webhook"]