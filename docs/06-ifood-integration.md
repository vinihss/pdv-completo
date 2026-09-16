# 06 — Integração iFood (Order + Catalog API)

Integração do PDV com a [iFood](https://developer.ifood.com.br/) para receber
pedidos do marketplace, sincronizar o cardápio e refletir o ciclo de vida do
pedido na comanda local. Roda **dentro do processo do backend** (módulo
in-process, mesmo padrão do `outbox-dispatcher` e do `whatsapp-webhook`), sem
serviço separado.

Este documento é o contrato interno do módulo. O shape exato dos payloads do
iFood e o código de razão de cancelamento devem ser confirmados na homologação
com um app real.

## Escopo

- **Receber** pedidos `CONFIRMED` via polling → criar comanda local
  (`channel='ifood'`, `external_ref=orderId do iFood`).
- **Sincronizar status** (`CONCLUDED`, `CANCELLED`, `STALE`,
  `CANCELLATION_REQUESTED`) → transições locais da comanda.
- **Sincronizar catálogo** (produtos/categorias) para o marketplace.
- Modo **mock** para desenvolvimento sem credenciais.

Fora de escopo desta etapa: aceitar cancelamentos com decisão manual por
gerente, cupom fiscal, e o retorno detalhado de itens (complements) na cozinha.

## Configuração (env)

| Variável | Padrão | Descrição |
|---|---|---|
| `IFOOD_SYNC_ENABLED` | `false` | Liga o worker em modo real (exige credenciais). |
| `IFOOD_CLIENT_ID` / `IFOOD_CLIENT_SECRET` | — | Credenciais do app centralizado (`client_credentials`). |
| `IFOOD_MERCHANT_ID` | — | Opcional. Se ausente, resolve via `GET /authentication/v1.0/merchants`. |
| `IFOOD_BASE_URL` | prod | Base da API (sandbox usa `https://merchant-api.ifood.com.br` em teste). |
| `IFOOD_MOCK` | `false` | Aponta o client para o mock local e **implica integração habilitada**. |
| `IFOOD_MOCK_PORT` | `3999` | Porta do mock. |
| `IFOOD_POLLING_INTERVAL_MS` | `30000` | Intervalo do polling. |

Regra de habilitação (`isIfoodEnabled`):

- `IFOOD_MOCK=true` → habilitado sem credenciais;
- senão, requer `IFOOD_SYNC_ENABLED=true` **e** `CLIENT_ID`/`CLIENT_SECRET`.

## Autenticação

`POST /authentication/v1.0/oauth/token` com `grantType=client_credentials`
(URL-encoded). O token é **cacheado** em `ifood_state` (`accessToken` +
`tokenExpiresAt`); quando expira ou recebe `401`, o client busca novo token e
re-tenta a chamada uma vez (`ifoodFetch`). Não há refresh — o token dura ~6h.

## Estado (KV `ifood_state`)

| Chave | Uso |
|---|---|
| `accessToken`, `tokenExpiresAt` | Cache do token. |
| `merchantId`, `merchantName` | Merchant resolvido (mock preenche ao subir). |
| `lastPollAt`, `lastPollError` | Saúde do worker (painel do gerente). |
| `lastCatalogSyncAt`, `lastCatalogSyncError` | Última sync de catálogo. |

## Fluxo de ingestão (evento `CONFIRMED`)

1. **Persistir** o evento em `ifood_event` **antes** do ACK (regra do iFood —
   eventos retidos até 8h; ack sem persistir leva a throttling e perda).
2. Buscar `GET /orders/{orderId}`.
3. **Casar itens** por `externalCode` (= `product.ifood_sku`) ou pelo id do
   produto no catálogo. Se algum SKU não casar → **não** abre pedido:
   `requestCancellation` e ACK (status `ignored`).
4. Resolver/criar cliente por **telefone** (mesma chave do self-service).
5. `openOrderUsecase` (`channel='ifood'`, `externalRef`, `tabLabel="iFood {displayId}"`,
   `waiterId="system"`, `deliveryFee`) + `addItemsUsecase`.
6. Entrega: `deliveredBy === "MERCHANT"` cria linha em `delivery`; entregue
   pelo iFood não tem courier local.
7. Persistir métodos de pagamento (`ifood_payments`) p/ fechar no `CONCLUDED`.
8. Broadcast `ifood.order.created` para a sala `deliveries` + `logAction`.
9. `POST /orders/{orderId}/confirm` (janela de 8 min). Se falhar, o evento fica
   `failed` e **re-tenta no próximo poll** (idempotente).
10. ACK em batch no fim do ciclo.

Dedupe/retry: `ifood_event.status ∈ processed | ignored | acked | failed`.
Eventos `failed` não são ackados → reentregues no próximo poll.

## Retorno de status

| Evento iFood | Ação local |
|---|---|
| `CONCLUDED` | Itens → `delivered`, pagamento mapeado (`PIX→pix`, `CASH→cash`, `CARD→card`, `ONLINE→other`), comanda `closed`, delivery `delivered`. |
| `CANCELLED` / `STALE` | Comanda `cancelled` (+ delivery `failed`), com `cancel_reason`. |
| `CANCELLATION_REQUESTED` | Aceita (best-effort) e cancela a comanda local. |
| `DISPATCHED` / `READY_TO_PICKUP` | Reconhecido, sem ação local (entrega via iFood). |

O fechamento no `CONCLUDED` respeita os métodos habilitados em
`store_settings.enabled_payment_methods`; se nenhum bater, registra via
`other` ou deixa para o gerente encerrar manualmente (auditado).

## Catálogo (Catalog v2.0)

`syncCatalogUsecase` (POST `/ifood/catalog-sync`, manager):

- garante as categorias locais ativas no catálogo `DEFAULT`;
- `PUT /items` com `{ items: [...] }` (chunks de 1000);
- `item.id = item.externalCode = product.ifood_sku` (ou `product.id` se sem
  SKU), `price`, `status = AVAILABLE` quando ativo, `category = { id }`,
  `internalId = product.id`.

Idempotente — pode rodar a qualquer momento.

## Mock (`IFOOD_MOCK=true`)

Sobe um HTTP server em `IFOOD_MOCK_PORT` com os mesmos endpoints que o client
consome (auth, order, catalog) + admin:

| Endpoint | Uso |
|---|---|
| `POST /__fixtures` | Injeta `{ events, order }` para o próximo poll. |
| `GET /__log` | Inspect de confirmações/ACKs/upserts. |
| `GET /__state` | Estado interno (categorias, itens). |

## Painel do gerente (frontend)

Aba **iFood** (após "Relatórios"): `GET /ifood/status` (conexão, último poll,
última sync, contagem de eventos/pedidos) e botão "Sincronizar catálogo"
(`POST /ifood/catalog-sync`). Ambas exigem papel `manager`.

## Pendências de homologação (app real)

- Confirmar o shape exato de `order.items[].complement` (variações) e do campo
  de endereço.
- Validar se `item.id` pode ser o `ifood_sku` (o exemplo oficial usa UUID v4) —
  se não, mapear id↔sku num KV próprio.
- Confirmar o código de razão de cancelamento (`CANCELLATION_REQUESTED`) via
  `GET /orders/{id}/cancellationReasons`.
- Telefone do cliente costuma vir **mascarado** — decidir política (rejeitar
  ou manter como vem) com o operador.
- Testar retry real de ACK e a janela de 8 min do `confirm`.