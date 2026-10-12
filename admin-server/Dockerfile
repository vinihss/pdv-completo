FROM golang:1.25-alpine AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

# Só `cmd/admin/main.go` não basta: o binário é isolado em módulo próprio e
# main.go importa `pdv-admin-server/internal/...`. Sem copiar os dois, o build
# falha com "package pdv-admin-server/internal/auth is not in std".
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -o admin-server ./cmd/admin/

FROM alpine:3.19

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /src/admin-server .

USER appuser

EXPOSE 9090

CMD ["./admin-server"]
