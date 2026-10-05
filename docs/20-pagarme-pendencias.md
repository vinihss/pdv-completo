# Pagar.me V5 — pendências e o que ficou para trás

Complementa `docs/19-pagarme.md`. Este arquivo é o **resto** do trabalho: o que
não foi feito, por que, e qual o risco de cada item ficar parado.

O fluxo principal (criar cobrança → webhook confirma → `order_payment`
confirmada → comanda fecha) **funciona e está testado** (20 testes em
`test/pagarme.test.ts`, 299 no total em 20 suítes). O que segue é dívida.

---

## 1. Endpoints de cancel/refund não confirmados na doc oficial

A referência "Criar pedido" cobre `POST /orders` e `GET /orders/{id}`, mas não
traz a de cancelamento/estorno. Os paths estão centralizados em
`integrations/pagarme/config.ts` com `@todo`:

```ts
cancelUrl: (orderId) => `${baseUrl}/orders/${orderId}/cancel`,
refundUrl: (orderId) => `${baseUrl}/orders/${orderId}/refunds`,
```

**Risco de errar:** baixo por construção. O estado local só muda por webhook
(`order.canceled`, `charge.refunded`) ou reconciliação — nunca pela resposta do
`cancel`/`refund`. Então um path errado aparece como "estorno não aconteceu" e
a reconciliação detecta, nunca como "estornado sem o PDV saber".

**Para resolver:** rodar uma cobrança de teste em sandbox e confirmar os paths
reais. Ajustar é uma linha em `config.ts`.

---

## 2. Frontend não ligado à cobrança do gateway

O backend devolve o QR do gateway (`payment.pix.qrCode`), mas a tela de
checkout continua gerando o BR Code local (`entities/payment/lib/pix.js`), que
é a chave estática da loja — não a cobrança com txid e expiração.

**Consequência:** hoje o cliente paga pelo QR local e o webhook do Pagar.me
nunca chega, porque a cobrança não foi criada no gateway. O fluxo do gateway
só é exercitado por teste ou por chamada direta à API.

**Para resolver:** PR próprio no frontend — trocar a geração do QR local pelo
`payment.pix.qrCode` devolvido por `POST /orders/:id/payments`, e exibir o
estado do pagamento (pending → paid) via polling ou realtime.

---

## 3. Tokenização de cartão no navegador

O backend aceita `cardToken`/`cardId` em `POST /orders/:id/payments`, mas não
há código no frontend que gere esse token. A V5 exige `card_token` (checkout
transparente) ou `card_id` (PSP) — e a doc avisa em caixa alta para não enviar
`card` com número/CVV, porque isso é o que exige PCI.

**Para resolver:** integrar o Pagar.me.js (ou o checkout transparente) no
frontend, gerar o token lá, e mandar só o token para o backend. O backend já
está pronto para receber.

---

## 4. Split e multi-tenant

O `PLANO_PAGARME.md` da raiz propõe `stores`, `store_id` em tudo e split por
recebedor em PRs separados. Nada disso existe no banco hoje: `store_settings`
é singleton e não há coluna `store_id` em lugar nenhum.

A doc oficial mostra que o split é `payments[].split[]` (por pagamento, com
`recipient_id` e `options{liable, charge_processing_fee,
charge_remainder_fee}`) — **não** é `split_rules` no topo, como o plano assume.

**Para resolver:** seguir o roadmap do `PLANO_PAGARME.md` (PRs 1-5), corrigindo
a forma do split. O mapper já tem o `split` isolado e comentado para isso.

---

## 5. Eventos do webhook precisam ser habilitados no painel

A lista de eventos que o Pagar.me envia é configurada no painel da conta, não
no código. Os relevantes para este fluxo são:

- `order.paid` — confirma o pagamento
- `order.payment_failed` — marca como falhou
- `order.canceled` — confirma o cancelamento
- `charge.refunded` — confirma o estorno
- `charge.paid` / `charge.payment_failed` / `charge.pending` — redundantes com
  os de `order`, mas úteis para reconciliação

**Para resolver:** no painel do Pagar.me, cadastrar a URL
`https://<dominio>/webhooks/pagarme` e marcar esses eventos. Sem isso, o
webhook nunca chega e tudo depende da reconciliação (10min de atraso).

---

## 6. Reconciliação não cobre estornos presos em `requested`

`reconcilePendingPaymentsUsecase` relê cobranças `pending`/`processing`. Um
estorno que ficou em `payment_refund.status = 'requested'` (o gateway aceitou
mas a resposta se perdeu antes de gravar) não é relido — a cobrança já está
`paid`/`partially_refunded`, então sai do filtro.

**Risco:** baixo. O `requestRefundUsecase` grava a linha `requested` antes de
chamar o gateway, e na aceitação já atualiza `refunded_amount` e o status. O
buraco é só se o processo cair entre "gravou requested" e "gateway respondeu".

**Para resolver:** estender a reconciliação para também reler
`payment_refund.status = 'requested'` e perguntar ao gateway o estado do
estorno.

---

## 7. Sem métricas, alertas e dashboard financeiro (Fase 4 da spec)

A spec §28 lista como critério de aceite "Observabilidade: correlation_id,
request_id, payment_id, order_id, provider_order_id, provider_charge_id" e
"Logs estruturados". O `applyCharge` já grava um log estruturado no
`audit_log` com esses campos, mas não há:

- métricas (taxa de sucesso, tempo até confirmação, volume por método);
- alertas (webhook falhando, reconciliação corrigindo muito, gateway fora);
- dashboard financeiro (conciliação automática).

**Para resolver:** Fase 4 da spec. O `audit_log` já tem os dados; falta
agregar e expor.

---

## 8. Sem testes de integração contra sandbox real

Os 20 testes usam um dublê do gateway (`setPaymentGatewayForTests`). Nenhum
teste bate na API real do Pagar.me em sandbox.

**Risco:** o mapper é tolerante e os paths de cancel/refund não foram
confirmados — um teste de integração em sandbox pegaria divergência de schema
que o dublê não pega.

**Para resolver:** suíte de integração opt-in (`PAGARME_SANDBOX=true`) que cria
uma cobrança real em sandbox, espera o webhook (ou reconcilia), e estorna.
Rodar manualmente antes de cada release, não no CI.

---

## 9. DLQ sem reprocessamento manual

Um evento que estoura o teto de 5 tentativas fica em `payment_event.status =
'failed'` com `next_attempt_at = NULL` — sai da fila e fica parado. Não há
endpoint para reprocessar nem para inspecionar a DLQ.

**Para resolver:** endpoint admin `POST /admin/payment-events/:id/retry` que
zera `attempts` e `next_attempt_at`, e uma tela no painel do gerente listando
os eventos em DLQ.

---

## 10. Sem validação de IP de origem do webhook

A assinatura HMAC-SHA1 é a única defesa do endpoint. A doc do Pagar.me
recomenda também validar o IP de origem (lista de IPs do gateway).

**Risco:** baixo enquanto a secret key for secreta — forjar uma assinatura
válida sem a key é o que o HMAC impede. Mas defesa em profundidade é barata.

**Para resolver:** middleware que checa o IP contra a lista publicada pelo
Pagar.me, configurável por env.

---

## 11. Sem idempotência no gateway

A doc oficial não documenta header de idempotência para `POST /orders`. A
idempotência é nossa: `withIdempotency` no endpoint, reuso da cobrança viva no
usecase, e `UNIQUE (order_id, attempt)` no banco.

**Risco:** se o processo cair entre "gravou payment pending" e "gateway
respondeu", a reconciliação encontra a tentativa pelo `(order, attempt)` e
pergunta ao gateway — mas se o gateway criou a cobrança e a resposta se perdeu,
a reconciliação vai achar a cobrança pelo `provider_order_id`... que não foi
gravado. Nesse caso a cobrança fica órfã no gateway.

**Para resolver:** quando a doc publicar o header de idempotência, mandar
`Idempotency-Key: payment:{order_id}:{attempt}` no `POST /orders`. Até lá, o
risco é uma cobrança órfã no gateway que o cliente não vê — o dinheiro não
entra porque o QR não foi exibido.

---

## 12. Sem suporte a boleto e débito

`PaymentMethod` é `"pix" | "credit_card"`. A V5 suporta `boleto` e
`debit_card`, mas o PDV não tem fluxo para eles (o enum do balcão é
`cash/card/pix/other`).

**Para resolver:** quando o produto pedir, estender `PaymentMethod` e o
`buildCreateOrderBody`. O mapper já trata `boleto`/`debit_card` devolvendo
`null` em vez de inventar.

---

## 13. Sem cancelamento automático de cobrança expirada

Uma cobrança Pix que o cliente não paga fica `pending` para sempre. Não há job
que cancele cobranças expiradas (o `pix_expires_at` é gravado mas não é
consultado).

**Para resolver:** job periódico que cancela cobranças `pending` com
`pix_expires_at` no passado, chamando `gateway.cancel` e marcando
`payment.status = 'canceled'` via webhook/reconciliação.

---

## 14. Sem notificação ao cliente quando o pagamento confirma

Quando o webhook marca `paid`, o cliente não recebe aviso. O WhatsApp já está
integrado (`integrations/whatsapp/`), mas não há hook do pagamento para ele.

**Para resolver:** no `applyCharge`, quando `alvo === 'paid'`, enfileirar uma
mensagem de WhatsApp para o cliente (se houver telefone). O outbox já existe
para isso.

---

## 15. Duas linhas confirmadas travam o fechamento da comanda

Há **três** lugares que inserem em `order_payment` com `confirmed = true`, e
só um deles tem guarda:

| Inserter | Guarda |
|---|---|
| `bridgePaidToOrder` (`payment.usecases.ts:603`) | sim — mesma linha se já existir confirmada com **mesmo método e mesmo valor** |
| `setOrderPaymentsUsecase` (`order.usecases.ts:756`) | sim — `planPaymentLines` recusa (`invalidTransition`) qualquer confirmada fora da lista |
| iFood `status-pushback.ts:92` | **nenhuma** |

`closeOrderUsecase` (`order.usecases.ts:928`) soma **todas** as linhas
confirmadas da comanda e compara com o total (`moneyEq(paid, total)`). Duas
linhas confirmadas estouram o total e o fechamento cai em
`invalidPaymentTotal` — a comanda fica aberta e não há como quitar.

### Cenário que falha de fato

A ordem importa, e as duas ordens não se comportam igual:

1. **Balcão primeiro, webhook depois.** O caixa registra `cash` confirmado; o
   webhook chega e `bridgePaidToOrder` insere `card` (de `credit_card`). A
   guarda compara método **e** valor — `cash` ≠ `card` — então **não** pega, e a
   segunda linha entra. Bug.
2. **Webhook primeiro, balcão depois.** A linha do gateway já está confirmada;
   o `PUT` do balcão manda só `cash`. `planPaymentLines` acha a confirmada sem
   par 1:1 e recusa com `invalidTransition` ("o estorno precisa ser explícito").
   O caixa é **bloqueado com mensagem clara** — não corrompe a comanda, mas é
   uma parede sem saída: a única forma de sair é estornar pelo fluxo de caixa.

O iFood (3º inserter) repete o padrão do caso 1: grava confirmada cobrindo o
total inteiro e não olha o que já existe.

**Risco:** médio. Não é corrupção de dado — é indisponibilidade do fechamento, e
a reconciliação do Pagar.me pode corrigir o `payment` sem desfazer o
`order_payment` que o balcão gravou, o que **estenderia** a janela. Raro: exige
o caixa registrando e o webhook chegando na mesma comanda.

**Para resolver:** decisão de produto antes de qualquer código. As saídas
possíveis são (a) `bridgePaidToOrder` recusar quando já houver **qualquer**
linha confirmada, em vez de só quando método e valor batem; (b) o balcão
deixar de registrar quando existe cobrança viva no gateway; (c) o
`closeOrderUsecase` absorver a linha extra. (a) é a mais barata e a que
evita as duas ordens, mas é mudança de fluxo: o cashier perde a possibilidade
de registrar pagamento manual numa comanda que já tem QR no ar — que é
justamente o cenário de "cliente pagou no gateway mas a fila travou".

---

## Resumo do que falta, por prioridade

| Prioridade | Item | Esforço |
|---|---|---|
| P0 | Ligar o frontend ao QR do gateway (item 2) | médio |
| P0 | Habilitar os eventos do webhook no painel (item 5) | baixo |
| P1 | Confirmar paths de cancel/refund em sandbox (item 1) | baixo |
| P1 | Tokenização de cartão no navegador (item 3) | médio |
| P1 | Teste de integração em sandbox (item 8) | médio |
| P2 | Reconciliação de estornos presos (item 6) | baixo |
| P2 | Cancelamento automático de expiradas (item 13) | baixo |
| P2 | Notificação WhatsApp no paid (item 14) | baixo |
| P2 | Linha de pagamento duplicada trava o fechamento (item 15) | médio, **decisão de produto antes de código** |
| P3 | Métricas/alertas/dashboard (item 7) | alto |
| P3 | DLQ com retry manual (item 9) | baixo |
| P3 | Validação de IP do webhook (item 10) | baixo |
| P3 | Idempotência no gateway (item 11) | baixo |
| P4 | Split e multi-tenant (item 4) | alto |
| P4 | Boleto e débito (item 12) | médio |
