# Contratos de API — Pedido Self-Service e Gerência de Entrega

Especificação dos endpoints novos que suportam `04-delivery-self-service-integration.md`. Segue exatamente as convenções já estabelecidas no backend: schemas Zod, `correlationId` para idempotência em toda escrita que cria recurso, `expectedVersion` para lock otimista, e `AppError` com `code` estável para cada erro de domínio.

## Convenções

- **Endpoints públicos** (`/public/*`) não exigem `authMiddleware` — são de leitura de cardápio e criação de pedido pelo cliente final. Todos têm rate limiting em memória por IP (e `POST /public/orders` também por telefone, pra não encher o WhatsApp de alguém com pedidos falsos): `publicLookupRateLimit` 20/min, `publicWriteRateLimit` 10/min, `publicCartRateLimit` 60/min (o PUT do carrinho é debounced no cliente), `publicOrderRateLimit` 5/min por IP **e** 5/min por telefone. `GET /public/menu` e `GET /public/orders/:id/status` não são limitados (superfície de leitura já existente).
- **Endpoints de entregador** (`/courier/*`) exigem `authMiddleware` + `requireRole("courier")`.
- **Endpoints de manager** (`/manager/deliveries/*`) exigem `authMiddleware` + `requireRole("manager")`.
- **Webhook do WhatsApp** (`/webhooks/whatsapp`) é autenticado por verificação de assinatura da Meta (`X-Hub-Signature-256`), não por JWT.
- Toda escrita que cria um recurso novo (pedido, endereço) exige `correlationId` no body, igual ao padrão já usado em `POST /orders`.

## Máquina de estado do cliente (stage canônico)

O cliente (página `/pedido` e bot do WhatsApp) **não** consome os 3 eixos internos
(`orders.status`, `order_item.status`, `delivery.status`) diretamente: eles são
detalhes de implementação que mudam conforme o fluxo. O que o cliente vê é um
**stage canônico**, derivado e exposto por `GET /public/orders/:id/status` em
`customerStage` — módulo puro `domain/customer-order-state.ts`.

```
received → preparing → ready → out_for_delivery → delivered
    ↘ cancelled            ↘ failed (terminais)
```

| stage | label | terminal | como é derivado |
|---|---|---|---|
| `cancelled` | Cancelado | sim | `orders.status = cancelled` (cancelou o gerente, o cliente ou a fonte de verdad — iFood). Vence qualquer outro eixo. |
| `failed` | Problema na entrega | sim | `delivery.status = failed` (entregador não conseguiu entregar; o pedido continua aberto). |
| `delivered` | Entregue | sim | `delivery.status = delivered` ou comanda fechada sem delivery ativa. |
| `out_for_delivery` | Saiu para entrega | não | `delivery.status = out_for_delivery` — tem precedência sobre fechamento de comanda. |
| `ready` | Pronto | não | todos os itens ativos em `ready`/`delivered`. |
| `preparing` | Preparando | não | mistura de itens `ordered` e prontos. |
| `received` | Pedido recebido | não | nenhum item ativo ou todos ainda `ordered` (nem começou o preparo). |

O mesmo stage vem no evento realtime `customer.stage_changed`
(`{ orderId, stage, label, terminal }`), emitido na **mesma transação** da
mutação de domínio que mudou a etapa (criação do pedido, último item pronto,
dispatch, deliver, fail, cancelamento).

Transições do eixo `delivery.status` (matriz única em
`DELIVERY_TRANSITIONS`, usada por dispatch/deliver/fail, cancelamento de
comanda e conclusão/cancelamento iFood):

| de | para |
|---|---|
| `awaiting_courier` | `out_for_delivery`, `cancelled` |
| `out_for_delivery` | `delivered`, `failed`, `cancelled` |
| `delivered` | — (terminal) |
| `failed` | `cancelled` |
| `cancelled` | — (terminal) |

Cancelamento de comanda (`cancelOrderUsecase`, via manager **ou** cliente)
propaga pra delivery na mesma transação: sem isso a entrega ficaria órfã no
painel do entregador e o cliente preso em "Pedido recebido" eterno.


## Endpoints públicos (cliente)

### `GET /public/menu`

Sem parâmetros. Retorna produtos ativos e visíveis nesse canal (respeitando `whatsappVisible`/equivalente, se existir).

```
200 → {
  categories: [{
    id: string, name: string,
    products: [{
      id, name, description, price,
      imagePath: string | null,     // "/uploads/<arquivo>"
      // Mesmo formato do payload interno de produto (features/orders usa o
      // mesmo VariationModal): o cliente precisa de `required` pra bloquear o
      // pedido sem opção obrigatória e de `allowMultiple` pra grupos de extras.
      variations: [{ name, options: string[], required: boolean, allowMultiple: boolean }] | null,
      // Vitrine da página: true = entra na seção "Destaques" (migration 0020).
      // Curadoria pura — o produto segue listado na sua categoria.
      featured: boolean
    }]
  }]
}
```

`variations: null` = produto sem opções. Legado (`variations: ["Limão","Morango"]`
no banco) é normalizado em um grupo `"Opção"` — o cliente nunca vê o formato cru.

`featured` vem de `product.featured`, marcado pelo gerente no cadastro do produto
("Em destaque na página de pedidos"). Default `false` — instalação existente não
muda de layout até alguém marcar. A seção de destaques é montada no cliente a
partir deste payload; o backend não tem endpoint próprio pra isso.

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

201 → { orderId, deliveryId, total, deliveryFee, estimatedMinutes }   // customerStage/timeline vêm do GET de status, não do create
400 → validation_failed
409 → address_limit_reached  (se newAddress e cliente já tem 3)
422 → variation_required      (linha sem grupo obrigatório selecionado; details.groups = grupos faltantes)
422 → variation_invalid       (opção que não existe mais no catálogo; details.{group, option})
```

As duas validações de variação rodam **antes de qualquer escrita** (antes de
criar comanda, itens, pagamento e entrega): `addItemsUsecase` persiste
`selectedVariations` sem conferir contra o produto, então sem essa guarda um
"X-Burger" sem "Ponto da carne" virava pedido e a cozinha recebia algo
impossível de produzir. Erro 422 (não 400) porque é o corpo que precisa de
correção pontual, não a requisição inteira.

Internamente: resolve/cria cliente → resolve/cria endereço → chama `openOrderUsecase({ tabLabel: "Delivery - <nome>", channel })` + `addItemsUsecase` → grava `orders.deliveryFee` a partir de `store_settings.delivery_fee`.

### `GET /public/orders/:id/status`

Polling simples; a página também assina o WebSocket público (ver abaixo) e
refaz este GET a cada `customer.stage_changed`, o que mantém a tela correta
mesmo com evento perdido no reconnect.

```
200 → {
  orderStatus: "open"|"closed"|"cancelled",
  itemsStatus: [{ id, status }],
  deliveryStatus: "awaiting_courier"|"out_for_delivery"|"delivered"|"failed"|"cancelled"|null,
  customerStage: { stage, label, terminal },
  timeline: [{ stage, label, done, current }],   // 5 etapas de progresso na ordem canônica
  total: number,
  estimatedMinutes: number
}
```

`total` e `estimatedMinutes` vêm aqui também (não só na criação) para que a
retomada por `?order=<id>` funcione sem o payload do `POST /public/orders`.

### `POST /public/orders/:id/cancel`

Cancelamento pelo cliente. O endpoint é público, então **o telefone é o dono**:
o UUID do pedido sozinho não autoriza (mesmo modelo de confiança do lookup de
cliente — superfície de leitura, sem JWT). Pedido inexistente e pedido alheio
devolvem a mesma resposta, sem revelar existência.

```
body: { correlationId, customerPhone }

200 → { orderId, status: "cancelled" }
400 → validation_failed   (telefone ausente/malformado)
403 → forbidden_role      (telefone não é o dono, ou pedido não é de canal self-service)
409 → invalid_transition  (já saiu para entrega, ou já entregue/cancelado)
```

Cancelável em `received`, `preparing`, `ready` e `failed` (a entrega falhou e
a comanda segue aberta — evita cobrança de um pedido que não existe). **Não**
cancelável em `out_for_delivery` (o entregador já saiu com o pedido) nem em
`delivered`/`cancelled`.

Idempotente por `correlationId`; o cancelamento usa o mesmo
`cancelOrderUsecase` do gerente (estorno de estoque/caixa, propagação pra
delivery, eventos outbox) e notifica o cliente por WhatsApp.

### `POST /public/orders/active`

Pedido em andamento do telefone, pra retomada ("Você tem um pedido em
andamento" na página, mesmo link que o bot manda).

```
body: { phone }
200 → { orderId, customerStage: { stage, label, terminal }, total, estimatedMinutes, openedAt }
200 → null        // sem cliente com esse telefone, ou sem pedido aberto
```

"Andamento" = `orders.status = open` de canal `whatsapp`/`web` (o mais recente
por `opened_at`). Serve também pro `failed`: o cliente precisa ver a falha pra
cancelar ou reordenar.

### Carrinho server-side (rascunho de continuação)

Tabela `customer_cart`, chaveada por telefone, TTL de 24h
(`expires_at`, expurgado pelo job de manutenção). Guarda **só os itens** — a
etapa do checkout (telefone/endereço/pagamento) é re-derivada: o custo de
persistir o checkout inteiro não paga a complexidade, e perder o rascunho antes
de o cliente informar o telefone é aceito (web direta).

```
GET    /public/cart?phone=<telefone>
200 → { items: [{ productId, quantity, selectedVariations?, notes? }] }   // [] se vazio ou expirado

PUT    /public/cart
body: { phone, items: [ ... máx. 50 ] }
200 → { ok: true }        // sobrescreve (PUT, não merge)

DELETE /public/cart
body: { phone }
200 → { ok: true }
```

`items` é rascunho sem validação: produto que saiu do menu é filtrado na
hidratação do cliente e rejeitado no submit (fonte da verdade continua sendo
`POST /public/orders`, que revalida preço/estoque).

## WebSocket público do cliente

```
GET /realtime/public        (upgrade, sem JWT)
→ { type: "join", room: "order:<orderId>" }
```

Sala única e restrita: só `order:<id>` (UUID da comanda, que já é a "senha" de
fato no `GET /public/orders/:id/status`). `join` de qualquer outra sala — ou de
um pedido que não existe — responde `join.denied`. Eventos: os mesmos do
`/realtime` autenticado, mais `customer.stage_changed` (room `order:<id>`).

O cliente trata o WS como otimização: o polling de 4s continua sendo o
garantidor de consistência (o backend não faz buffer de evento perdido).

## Webhook do WhatsApp

### `GET /webhooks/whatsapp`

Verificação de assinatura exigida pela Meta (`hub.challenge`) — sem lógica de negócio.

### `POST /webhooks/whatsapp`

Recebe evento de mensagem inbound. Fluxo interno (implementado em `handleIncomingWhatsAppMessage`):

1. Extrai telefone e conteúdo da mensagem (`webhook-payload.ts#extractIncomingMessage`).
2. Busca ou atualiza `whatsapp_conversation` pelo telefone — usada só pra saber se já cumprimentou nesta janela de 1h, não pra conduzir carrinho.
3. Busca pedido self-service **em aberto** do telefone (`POST /public/orders/active`, mesma query do banner da página):
   - **com** pedido em aberto → responde com o stage atual e o link direto do acompanhamento (`?via=whatsapp&phone=…&order=<orderId>`);
   - **sem** pedido → monta o link do cardápio (`?via=whatsapp&phone=…`).
4. Responde com saudação completa (primeira mensagem da janela) ou só o link (mensagens seguintes).

Não chama `createSelfServiceOrderUsecase()` nem os endpoints de cliente/endereço — o pedido em si é criado depois, quando o cliente fecha o checkout em `POST /public/orders` na página, com `channel: "whatsapp"` porque chegou pelo link.

Não há resposta síncrona significativa pro Fastify além de `200 OK` — a resposta ao cliente acontece de forma assíncrona, via chamada à Cloud API.

## Endpoints do entregador

### `GET /courier/deliveries`

```
query: ?status=awaiting_courier,out_for_delivery[,delivered,failed,cancelled]   // default: as duas primeiras
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
query: ?status=awaiting_courier,out_for_delivery,delivered,failed,cancelled
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

## Erros de domínio

Em `domain/errors.ts`, no padrão existente (`code` estável + status HTTP):

```
addressLimitReached: () =>
  new AppError("address_limit_reached", 409, "Limite de 3 endereços por cliente atingido."),
duplicatePhone: () =>
  new AppError("duplicate_phone", 409, "Telefone já cadastrado."),
invalidCourierRole: () =>
  new AppError("invalid_courier_role", 400, "Usuário indicado não é um entregador."),
invalidDeliveryTransition: (msg) =>
  new AppError("invalid_transition", 409, msg),
```

Sobre `invalid_transition`: o `code` é o mesmo nos dois contextos, mas o status
difere — `invalidTransition` (400) cobre transição de `order_item.status`
(erro de validação do request, ver `01-backend-spec.md`), enquanto
`invalidDeliveryTransition` (409) cobre transição do eixo `delivery.status` e o
cancelamento público do cliente, que são **conflito de estado** do pedido.
Implementação: uma única fábrica `invalidDeliveryTransition(msg)` com a
mensagem específica do caso (as duas fábricas distintas
`deliveryNotAwaitingCourier`/`deliveryNotOutForDelivery` do desenho original
foram colapsadas nela — a mensagem já é autoexplicativa e o `code` é o mesmo).
