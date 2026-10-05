# Pagar.me V5 — camada de pagamentos

Integração de cobrança no gateway Pagar.me V5 (Pix e cartão de crédito), com
webhook idempotente, reconciliação e estorno. O domínio não conhece o Pagar.me:
a interface `PaymentGateway` mora em `domain/payment.ts` e a `PagarmeGateway`
(em `integrations/pagarme/`) a implementa.

> Esta camada cobre o **backend**. O frontend ainda não foi ligado a ela — o QR
> do gateway é devolvido pela API, mas a tela de checkout continua gerando o BR
> Code local (`entities/payment/lib/pix.js`). Ligar o frontend é um PR próprio.

## Onde está o quê

| Camada | Arquivo | Papel |
|---|---|---|
| domínio | `src/domain/payment.ts` | `PaymentStatus`, máquina de transições, `PaymentGateway`, `PaymentGatewayError` |
| aplicação | `src/application/payment/payment.usecases.ts` | criar/consultar/cancelar/estornar, processar webhook, reconciliar |
| infra | `src/integrations/pagarme/{config,client,types,mapper,gateway,webhook-signature,worker}.ts` | HTTP Basic, timeout, classificação de erro, tradução de payload, assinatura, worker |
| http | `src/http/routes/payment.routes.ts` | endpoints autenticados (caixa/gerente) |
| http | `src/http/routes/pagarme-webhook.routes.ts` | `POST /webhooks/pagarme` (sem sessão; prova-se pela assinatura) |
| banco | `migrations/0002_pagarme.sql` | `payment`, `payment_event`, `payment_refund` |

## `payment` NÃO é `order_payment`

A armadilha nº1 deste módulo. As duas tabelas são "pagamento" e não têm a mesma
cara:

- **`order_payment`** — linha registrada pela pessoa no balcão. É a fonte de
  verdade do caixa (`cashPaymentsBetween`) e dos relatórios de venda. Existe
  mesmo sem gateway.
- **`payment`** — a cobrança no gateway. Uma linha por tentativa
  (`order_id` + `attempt`), com os ids externos (`or_`/`ch_`/`pay_`) e o QR da
  cobrança.

Quando o webhook confirma `paid`, a aplicação escreve uma linha **confirmada**
em `order_payment` (com `SYSTEM_USER_ID` como responsável), para a comanda
poder fechar e o relatório enxergar o dinheiro. O pedido **não** é fechado
automaticamente — fechar continua sendo ato do garçom/gerente.

## Fluxo do Pix

```
POST /orders/:id/payments { method: "pix" }
  → createPaymentUsecase
      → grava payment (pending) ANTES de chamar o gateway
      → PagarmeGateway.create → POST /orders
      → devolve QR (quando o gateway manda)
cliente paga
  → Pagar.me → POST /webhooks/pagarme (order.paid)
      → valida X-Hub-Signature (HMAC-SHA1 do corpo cru)
      → grava payment_event (UNIQUE provider+event_id) → 200
      → worker drena a inbox → applyCharge → payment=paid
      → bridge: order_payment confirmada + orders.paymentConfirmedAt
```

A confirmação **nunca** vem da resposta da criação (spec §12): um 200 de
`POST /orders` é o gateway aceitando o pedido de cobrança, não o dinheiro
entrando. O que confirma é o webhook — ou, se ele se perder, a reconciliação.

## Idempotência (três camadas)

1. **`withIdempotency`** no endpoint de criação: retry do MESMO request devolve
   a resposta cacheada.
2. **Reuso da cobrança viva** no usecase: se já existe `payment` `pending`/
   `processing` para o mesmo método, devolve ela em vez de criar outra. É o que
   impede o duplo clique em "Pagar" de gerar dois QR codes.
3. **`UNIQUE (order_id, attempt)`** no banco: duas requisições concorrentes que
   calcularam o mesmo `attempt` colidem, e a perdedora relê a da vencedora.

No webhook, a idempotência é o `UNIQUE (provider, event_id)` em
`payment_event`: reenvio do mesmo evento é 200 sem efeito novo.

## Reconciliação (spec §22)

Worker a cada `PAGARME_RECONCILIATION_INTERVAL_MS` (10min) relê no gateway as
cobranças `pending`/`processing` e aplica o estado que o gateway diz. É a
recuperação de webhook perdido — e o caminho que preenche o QR que a doc
oficial não mostra de onde vem.

## Estorno (spec §21)

`POST /payments/:id/refund` com `amount` opcional (ausente = integral). O
saldo estornável é `amount - refunded_amount`; estorno maior é 422. O gateway
aceitando o estorno já atualiza `refunded_amount` e o status
(`partially_refunded`/`refunded`) — sem isso, dois pedidos concorrentes
passariam os dois na checagem. O webhook `charge.refunded` reconfirma depois.

## Configuração

```env
PAGARME_ENABLED=true
PAGARME_BASE_URL=https://api.pagar.me/core/v5   # sandbox: https://sdx-api.pagar.me/core/v5
PAGARME_SECRET_KEY=sk_test_...                   # NUNCA no frontend
PAGARME_RECONCILIATION_INTERVAL_MS=600000
```

E o toggle do gerente: `store_settings.pagarme_enabled = true`. Os dois são
obrigatórios — sem a chave, `pagarme_not_configured` (409) diz o que falta.

## Decisões que fogem da spec original, e por quê

A spec enviada foi escrita para PHP/Laravel e para um Postgres com
`UUID`/`TIMESTAMPTZ`/`JSONB`/`BIGINT` de centavos. Este repo é Node+TS+Fastify+
Drizzle e tem convenções deliberadas. As adaptações:

| Spec | Aqui | Por quê |
|---|---|---|
| RabbitMQ (exchange/queues/DLQ) | `payment_event` como fila + worker com advisory lock | o repo não tem broker; o deploy é blue/green. O princípio da spec (persistir antes do processamento) é mantido |
| `amount BIGINT` em centavos | `amount REAL` em reais | NUMERIC devolveria string do node-postgres e quebraria `round2`/`moneyEq`. Centavos só na borda, no mapper |
| `UUID` PK, `TIMESTAMPTZ`, `JSONB` | `text` PK, `text` ISO-8601, JSON em `text` | convenção do schema inteiro (ver cabeçalho de `schema.ts`) |
| Order com `PENDING_PAYMENT/CONFIRMED/PREPARING/...` | `order.status` continua `open/closed/cancelled` | o enum é carregado por cozinha, relatórios, caixa e critérios de aceite. A independência pedido-vs-pagamento fica na entidade `payment` |
| `payment_operations` | `UNIQUE (order_id, attempt)` + `withIdempotency` | a unicidade faz o papel da tabela |
| Multi-tenant + split por recebedor | fora de escopo | o `PLANO_PAGARME.md` da raiz propõe isso em PRs separados e nada disso existe no banco |

## O que a doc oficial do Pagar.me V5 diz (e o que não diz)

Confirmado na referência "Criar pedido" (OpenAPI 3.1, server
`https://api.pagar.me/core/v5`):

- autenticação é **HTTP Basic** (`Authorization: Basic base64(secretKey + ":")`),
  não Bearer;
- `POST /orders` exige `items` e `payments`; `items[].code` é obrigatório;
  `items[].amount` é o valor **unitário** e o pedido não tem campo de total;
- `customer` ou `customer_id` é obrigatório; dentro de `customer`, só `name`;
- cartão por `payments[].credit_card.card_id` / `.card_token` — a doc avisa em
  caixa alta para não enviar `card` com número/CVV (PCI);
- split é `payments[].split[]` (por pagamento), com `recipient_id` e
  `options{liable, charge_processing_fee, charge_remainder_fee}` — **não** é
  `split_rules` no topo (o `PLANO_PAGARME.md` assume o contrário);
- `code` é a referência da loja, máx. 52 caracteres; `closed` decide se o
  pedido nasce aberto ou fechado.

**Não confirmado** — e é por isso que o mapper é tolerante:

- o schema de **resposta** da página de criação está copiado do endpoint de
  cobrança (id `ch_`, sem `items` e sem `payments[]`);
- `qr_code`, `qr_code_base64`, `txid`, `expires_at` **não aparecem** em lugar
  nenhum daquele documento — o mapper procura o QR em vários caminhos;
- a doc não enumera os valores de `status` — `mapStatus` devolve `null` para
  valor desconhecido em vez de inventar estado financeiro;
- não há header de idempotência documentado — a idempotência é nossa.

A assinatura do webhook é `X-Hub-Signature`: HMAC-SHA1 do corpo cru com a
secret key (o exemplo canônico da doc é `cat body | openssl dgst -sha1 -hmac
"<key>"`).

## Pendências conhecidas

A lista completa, com risco e prioridade de cada item, está em
`docs/20-pagarme-pendencias.md`. Resumo:

- **Endpoints de cancel/refund não confirmados na doc oficial** — centralizados
  em `config.ts` com `@todo`. Errar o path custa "estorno não aconteceu" (a
  reconciliação detecta), nunca "estornado sem o PDV saber".
- **Frontend não ligado** — o QR do gateway é devolvido pela API, mas a tela de
  checkout continua no BR Code local. Ligar é PR próprio.
- **Tokenização de cartão no navegador** — o backend aceita `cardToken`/
  `cardId`, mas não há código no frontend que gere o token.
- **Split e multi-tenant** — ficam para o roadmap do `PLANO_PAGARME.md`.
