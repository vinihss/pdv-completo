# Impressão web automática

O daemon usa uma conexão de saída iniciada pela loja. Nenhuma porta pública é aberta para a nuvem.

## Configuração

```json
"cloud": {
  "enabled": true,
  "base_url": "https://api.exemplo.com",
  "station_id": "loja-001-caixa-01",
  "token": "TOKEN_DA_ESTACAO",
  "events_path": "/v1/print-events",
  "ack_path": "/v1/print-events/{external_event_id}/ack",
  "status_path": "/v1/print-events/{external_event_id}/status",
  "poll_interval_seconds": 3,
  "batch_size": 20,
  "request_timeout_seconds": 15
}
```

Fora de localhost, `base_url` precisa usar HTTPS. O token deve ser exclusivo da estação e revogável no backend. Para não deixar o segredo no JSON, também é possível deixar `cloud.token` vazio e definir `PDV_CLOUD_TOKEN` no ambiente do serviço.

## Resposta de polling

`GET /v1/print-events?station_id=...&cursor=...&limit=20`

```json
{
  "events": [
    {
      "external_event_id": "evt_01HXYZ",
      "cursor": "000042",
      "print": {
        "job_id": "order-123-kitchen",
        "order_id": "order-123",
        "destination": "kitchen",
        "order": {
          "number": "#123",
          "items": [],
          "total_cents": 2590
        }
      }
    }
  ],
  "next_cursor": "000042"
}
```

O `external_event_id` precisa ser estável. Reentregas do mesmo evento são seguras porque o daemon usa uma chave única local por `external_event_id + destination`.

## ACK

Depois que o job foi persistido no SQLite local, o daemon envia:

```http
POST /v1/print-events/evt_01HXYZ/ack
```

```json
{
  "station_id": "loja-001-caixa-01",
  "external_event_id": "evt_01HXYZ",
  "destination": "kitchen",
  "job_id": "order-123-kitchen",
  "status": "accepted"
}
```

`accepted` significa **persistido na fila local**, não significa que o papel já saiu.

Para payload inválido, o daemon envia `status: "rejected"`. Para falhas temporárias como impressora não configurada, o evento não é confirmado e poderá ser reprocessado depois.

## Status posterior

Quando o processamento local termina, o daemon envia para `status_path`:

```json
{
  "station_id": "loja-001-caixa-01",
  "external_event_id": "evt_01HXYZ",
  "job_id": "order-123-kitchen",
  "status": "sent_to_printer"
}
```

Estados possíveis incluem:

```text
sent_to_printer
retry_waiting
reprint_confirmation
failed
```

O backend deve tratar status como eventos idempotentes. O daemon pode reenviar status após uma falha de rede.

## Limitação atual

O status posterior é enviado uma vez por processamento. Para garantia de entrega de status em caso de queda simultânea do daemon e da nuvem, a próxima evolução deve persistir uma outbox de callbacks local e reenviar com backoff.
