# Contratos de API — Pedido Self-Service e Gerência de Entrega

Especificação dos endpoints novos que suportam `04-delivery-self-service-integration.md`. Segue exatamente as convenções já estabelecidas no backend: schemas Zod, `correlationId` para idempotência em toda escrita que cria recurso, `expectedVersion` para lock otimista, e `AppError` com `code` estável para cada erro de domínio.

## Convenções

- **Endpoints públicos** (`/public/*`) não exigem `authMiddleware` — são de leitura de cardápio e criação de pedido pelo cliente final. Precisam de rate limiting por IP/telefone (a definir na implementação, fora do escopo deste contrato).
- **Endpoints de entregador** (`/courier/*`) exigem `authMiddleware` + `requireRole("courier")`.
- **Endpoints de manager** (`/manager/deliveries/*`) exigem `authMiddleware` + `requireRole("manager")`.
- **Webhook do WhatsApp** (`/webhooks/whatsapp`) é autenticado por verificação de assinatura da Meta (`X-Hub-Signature-256`), não por JWT.
- Toda escrita que cria um recurso novo (pedido, endereço) exige `correlationId` no body, igual ao padrão já usado em `POST /orders`.

## Endpoints públicos (cliente)

### `GET /public/menu`

Sem parâmetros. Retorna produtos ativos e visíveis nesse canal (respeitando `whatsappVisible`/equivalente, se existir).

```
200 → {
  categories: [{
    id: string, name: string,
    products: [{ id, name, price, variations: Record<string, string[]> | null }]
  }]
}
```

### `POST /public/customers/lookup`

```
body: { phone: string }

200 → { customerId, name, addresses: [{ id, label, street, number, complement, neighborhood, city, reference, isDefault }] }
404 → not_found  (cliente novo — frontend segue para cadastro)
```

### `POST /public/customers`

```
body: { correlationId, name, phone }
201 → { customerId }
409 → duplicate_phone  (telefone já cadastrado — use lookup)
```

### `POST /public/customers/:id/addresses`

```
body: { correlationId, label?, street, number, complement?, neighborhood, city, reference?, isDefault? }
201 → { addressId }
409 → address_limit_reached  ("Este cliente já tem 3 endereços cadastrados.")
```

### `POST /public/orders`

Ponto único de checkout — sempre chamado pela página, mesmo quando o cliente chegou pelo link do WhatsApp (o bot não chama isso diretamente, ver "Webhook do WhatsApp" abaixo).

```
body: {
  correlationId: string,
  channel: "whatsapp" | "web",  // default "web" — a página passa "whatsapp" quando leu ?via=whatsapp da URL
  customerPhone: string,
  customerName: string,
  addressId?: string,          // endereço salvo
  newAddress?: {...},           // OU endereço novo inline (mesmos campos de POST /addresses)
  items: [{ productId, quantity, selectedVariations?, notes? }],
  paymentMethodIntent: "cash" | "card" | "pix" | "other"
}

201 → { orderId, total, deliveryFee, estimatedMinutes }
400 → validation_failed
409 → address_limit_reached  (se newAddress e cliente já tem 3)
```

Internamente: resolve/cria cliente → resolve/cria endereço → chama `openOrderUsecase({ tabLabel: "Delivery - <nome>", channel })` + `addItemsUsecase` → grava `orders.deliveryFee` a partir de `store_settings.delivery_fee`.

### `GET /public/orders/:id/status`

Polling simples; a página também pode assinar o mesmo canal WebSocket que o PDV interno usa (`order:<id>`), evitando poll constante.

```
200 → { orderStatus: "open"|"closed", itemsStatus: [...], deliveryStatus: "awaiting_courier"|"out_for_delivery"|"delivered"|"failed"|null }
```

## Webhook do WhatsApp

### `GET /webhooks/whatsapp`

Verificação de assinatura exigida pela Meta (`hub.challenge`) — sem lógica de negócio.

### `POST /webhooks/whatsapp`

Recebe evento de mensagem inbound. Fluxo interno (implementado em `handleIncomingWhatsAppMessage`):

1. Extrai telefone e conteúdo da mensagem (`webhook-payload.ts#extractIncomingMessage`).
2. Busca ou atualiza `whatsapp_conversation` pelo telefone — usada só pra saber se já cumprimentou nesta janela de 1h, não pra conduzir carrinho.
3. Monta o link da página externa com `?via=whatsapp&phone=<telefone>` embutido.
4. Responde com saudação completa (primeira mensagem da janela) ou só o link (mensagens seguintes).

Não chama `createSelfServiceOrderUsecase()` nem os endpoints de cliente/endereço — o pedido em si é criado depois, quando o cliente fecha o checkout em `POST /public/orders` na página, com `channel: "whatsapp"` porque chegou pelo link.

Não há resposta síncrona significativa pro Fastify além de `200 OK` — a resposta ao cliente acontece de forma assíncrona, via chamada à Cloud API.

## Endpoints do entregador

### `GET /courier/deliveries`

```
query: ?status=awaiting_courier,out_for_delivery   // default: as duas
200 → [{ id, orderId, address, status, dispatchedAt, deliveredAt }]
```

Filtra automaticamente por `courier_id = <usuário autenticado>` — entregador nunca vê entregas de outro.

### `PATCH /courier/deliveries/:id/dispatch`

```
200 → { id, status: "out_for_delivery", dispatchedAt }
409 → invalid_transition  (se não estava awaiting_courier ou não é o entregador atribuído)
```

### `PATCH /courier/deliveries/:id/deliver`

```
200 → { id, status: "delivered", deliveredAt }
409 → invalid_transition  (se não estava out_for_delivery)
```
Dispara `whatsapp.notifier.ts` de forma assíncrona (outbox), notificando o cliente.

### `PATCH /courier/deliveries/:id/fail`

```
body: { reason: string }
200 → { id, status: "failed", notes: reason }
409 → invalid_transition
```

## Endpoints do manager

### `GET /manager/deliveries`

```
query: ?status=awaiting_courier,out_for_delivery,delivered,failed
200 → [{ id, orderId, address, status, courier: { id, name } | null, dispatchedAt, deliveredAt }]
```

### `PATCH /manager/deliveries/:id/assign`

```
body: { courierId: string }
200 → { id, courierId }
400 → invalid_courier_role  (se o usuário indicado não tem role courier)
```

Atribuir não muda `status` — continua `awaiting_courier` até o próprio entregador confirmar saída via `PATCH /courier/deliveries/:id/dispatch`. Essa separação é intencional: o manager decide quem vai, o entregador confirma que de fato saiu.

### `GET /manager/couriers`

```
200 → [{ id, name, active }]   // users com role = courier
```

## Novos erros de domínio

A adicionar em `domain/errors.ts`, seguindo o padrão existente (`code` estável + status HTTP):

```
addressLimitReached: () =>
  new AppError("address_limit_reached", 409, "Limite de 3 endereços por cliente atingido."),
duplicatePhone: () =>
  new AppError("duplicate_phone", 409, "Telefone já cadastrado."),
invalidCourierRole: () =>
  new AppError("invalid_courier_role", 400, "Usuário indicado não é um entregador."),
deliveryNotAwaitingCourier: () =>
  new AppError("invalid_transition", 409, "Entrega não está aguardando entregador."),
deliveryNotOutForDelivery: () =>
  new AppError("invalid_transition", 409, "Entrega não está em trânsito."),
```
