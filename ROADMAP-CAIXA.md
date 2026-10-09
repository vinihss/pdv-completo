# Roadmap — Improvements Caixa

> Consolidado de `docs/improvements-caixa/ANALISE-PROPOSTA-FLUXO-CAIXA-RELATORIOS.md` e
> `docs/improvements-caixa/MODELO-RELATORIO-CONCILIACAO-FECHAMENTO-CAIXA.md`,
> cruzado com os Tier 0 do `docs/14-usabilidade-e-processos.md`.
>
> Este arquivo é o **backlog executável** desta feature. Cada bloco vira PR
> próprio, com migration numerada, testes e revisão do diff antes de avançar.

## Convenções

- **Migrations**: sequencial (`0005_*`, `0006_*`, …), sempre idempotentes (`IF NOT EXISTS` / `DO $$ … $$`).
- **Schema**: novas colunas seguem o padrão do `backend/src/infra/db/schema.ts` (text ISO-8601, real para dinheiro, JSONB como text).
- **Backend**: camadas `domain → application → infra → http`; `withIdempotency` nos endpoints de mutação críticos; `logAction` + `enqueueEvent` dentro da transação.
- **Frontend**: FSD; overlays com dono (`Modal`/`Drawer`); valores monetários em `formatBRL`; `useRealtime` para o room `cash-drawer`.
- **Testes**: `backend/test/cash-flow.test.ts` (vitest + Postgres `pdv_test`); `frontend/` (vitest + jsdom).
- **Ordem**: cada bloco depende do anterior só quando indicado. Bloco sem dependência pode ser executado em paralelo.

---

## Bloco 1 — Fechamento com contagem por denominação (P0.1)

**Objetivo**: eliminar o pré-preenchimento do valor contado (linha 7 do `CloseCashDrawerModal.jsx`) e exigir contagem por cédula.

### 1.1 Migration `0005_cash_drawer_denominations.sql`

- `ALTER TABLE cash_drawer ADD COLUMN closing_denominations text` (JSON string — mesmo padrão de `products.variations` e `order_item.selected_variations`).
- `ALTER TABLE cash_drawer ADD COLUMN closing_justification text`.
- `ALTER TABLE cash_drawer ADD COLUMN closing_approved_by text REFERENCES user(id)`.
- `ALTER TABLE store_settings ADD COLUMN cash_closing_tolerance real NOT NULL DEFAULT 0` (tolerância em R$ para dispensar justificativa).
- `ALTER TABLE store_settings ADD COLUMN cash_closing_require_approval_above real NOT NULL DEFAULT 0` (acima deste valor, exigir aprovação do gerente).

### 1.2 Backend `cash-flow.usecases.ts`

- `closeCashDrawerUsecase` aceita `denominations?`, `justification?`, `approvedBy?`.
- Valida: se `|difference| > tolerance` e `justification` vazia → 422 `closing_justification_required`.
- Valida: se `|difference| > requireApprovalAbove` e `approvedBy` vazio → 422 `closing_approval_required`.
- Valida: se `denominations` informado, a soma das cédulas bate com `countedAmount` → 422 `closing_denominations_mismatch`.
- Persiste `closing_denominations` como JSON string.

### 1.3 Frontend `CloseCashDrawerModal.jsx`

- `useState(expected.toFixed(2))` → `useState("")` (campo em branco).
- Acrescentar painel de contagem por denominação (R$200/100/50/20/10/5/2/1 + moedas) com total calculado.
- Campo "total manual" como alternativa (hoje único campo) — só aparece se o operador escolher.
- Campo "justificativa" obrigatório quando `|difference| > tolerance`.
- Campo "aprovador" (PIN do gerente) quando `|difference| > requireApprovalAbove`.

### 1.4 Testes

- Backend: fechar sem contagem (aceito, soma zerada), fechar com denominação errada (422), fechar com diferença acima da tolerância sem justificativa (422), fechar com aprovação exigida sem aprovador (422).
- Frontend: render inicial com campo vazio, total calculado ao digitar quantidade, justificativa obrigatória quando diferença excede.

**Arquivos**: `backend/migrations/0005_*.sql`, `backend/src/infra/db/schema.ts`, `backend/src/application/cash-flow/cash-flow.usecases.ts`, `backend/src/http/routes/cash-drawer.routes.ts`, `backend/src/domain/errors.ts`, `frontend/src/widgets/cash-drawer/CloseCashDrawerModal.jsx`, `backend/test/cash-flow.test.ts`, `frontend/src/widgets/cash-drawer/__tests__/`.

---

## Bloco 2 — Serialização + idempotência (P0.2 + Tier 0 #6)

**Objetivo**: fechar a corrida de sangrias simultâneas e cobrir os 3 endpoints de pagamento sem idempotência.

### 2.1 SELECT FOR UPDATE em `findOpenDrawerTx`

- `findOpenDrawerTx` passa a usar `FOR UPDATE` na leitura da sessão aberta.
- Teste: duas sangrias concorrentes cujo total excede o disponível → uma deve receber 409.

### 2.2 Idempotência em pagamentos

- `PUT /orders/:id/payments`, `PATCH /orders/:id/payments/:paymentId`, `DELETE /orders/:id/payments/:paymentId` passam por `withIdempotency` com `correlationId` do body.
- Schema Zod: adicionar `correlationId` (UUID) obrigatório nos três.
- Frontend `PaymentModal.jsx`: gera `correlationId` estável por sessão de cobrança (não por clique) e reaproveita em retry.

### 2.3 Testes

- Backend: replay idempotente dos 3 endpoints (mesma resposta, banco inalterado no segundo).
- Backend: duas sangrias concorrentes (Promise.all) — ao menos uma falha.

**Arquivos**: `backend/src/application/cash-flow/cash-flow.usecases.ts`, `backend/src/http/routes/order.routes.ts`, `backend/src/http/schemas/order.schema.ts` (ou equivalente), `backend/src/application/order/order.usecases.ts`, `frontend/src/features/orders/PaymentModal.jsx`, `backend/test/cash-flow.test.ts`, `backend/test/order-payment.test.ts` (novo).

---

## Bloco 3 — Correção do bypass iFood (Tier 0 #1 + #2)

**Objetivo**: fechar o furo em que pedido iFood "em dinheiro" entra no esperado sem gaveta aberta, e o `confirmedAt` ser o momento do webhook em vez da venda.

### 3.1 `status-pushback.ts`

- Se o método escolhido for `cash` e não houver gaveta aberta, a conclusão do pedido iFood **grava o pagamento pendente** (`confirmed=false`) e gera alerta (auditoria + room `alerts`) para o operador confirmar quando abrir o caixa, em vez de inserir direto como confirmado.
- `confirmedAt` passa a ser o timestamp da venda (quando o iFood informar) ou, na ausência, o `created_at` do pedido no backend — nunca o momento do webhook.

### 3.2 Testes

- iFood em dinheiro com caixa fechado → pagamento gravado `confirmed=false`, alerta emitido, caixa não contaminado.
- iFood em dinheiro com caixa aberto → fluxo atual preservado.
- iFood Pix/cartão → fluxo atual preservado (esses não passam pela gaveta).

**Arquivos**: `backend/src/integrations/ifood/status-pushback.ts`, `backend/test/ifood-pushback.test.ts` (novo).

---

## Bloco 4 — Estorno com refund rastreável (A4 parcial + Tier 0 #3)

**Objetivo**: venda estornada vira linha negativa no relatório, não desaparece.

### 4.1 Migration `0006_order_refund.sql`

- `CREATE TABLE order_refund (id text PK, order_id, order_payment_id, amount, method, reason, status, requested_by, requested_at, settled_at, created_at)`.
- Índices por `order_id`, `order_payment_id`, `status`.

### 4.2 Backend

- Novo usecase `refundOrderPaymentUsecase({ orderId, paymentId, amount, reason, userId })`:
  - Dinheiro: gera sangria automática com `ref_order_id` (reaproveita o mecanismo do `cancelOrderUsecase`) e grava `order_refund` com `status='settled'`.
  - Pix/cartão: grava `order_refund` com `status='requested'` (futuro: integra com Pagar.me em `payment_refund`).
- Relatório de vendas (`report.usecases.ts`) passa a subtrair refunds `settled` do faturamento (linha negativa) em vez de apagar a venda.

### 4.3 Frontend

- Botão "Estornar pagamento" no detalhe da comanda fechada (manager).
- Modal com motivo obrigatório, confirmação de PIN.

### 4.4 Testes

- Backend: estorno em dinheiro com gaveta aberta → sangria + refund settled + relatório mostra líquido correto.
- Backend: estorno com gaveta fechada → 409 (como o cancelamento já faz).
- Backend: relatório com vendas + estornos → faturamento líquido correto.

**Arquivos**: `backend/migrations/0006_*.sql`, `backend/src/infra/db/schema.ts`, `backend/src/application/refund/` (novo), `backend/src/application/report.usecases.ts`, `backend/src/http/routes/refund.routes.ts` (novo), `frontend/src/features/refund/` (novo), `backend/test/refund.test.ts` (novo), `backend/test/report.test.ts`.

---

## Bloco 5 — Settlement iFood (D1)

**Objetivo**: separar receita bruta de repasse líquido — fim da receita de marketplace contaminada.

### 5.1 Migration `0007_order_settlement.sql`

- `CREATE TABLE order_settlement (id, order_id UNIQUE, channel, gross_amount, commission_amount, marketplace_fee, delivery_fee_subsidy, payout_amount, payout_status, payout_expected_at, payout_settled_at, external_ref, notes, created_at, updated_at)`.
- Índices por `order_id`, `channel`, `payout_status`, `payout_expected_at`.

### 5.2 Backend

- Usecase `registerSettlementUsecase` (manager): grava/atualiza os valores de comissão e repasse previsto.
- Usecase `markSettledUsecase`: marca um settlement como pago, total ou parcial.
- Endpoint `POST /settlements` e `PATCH /settlements/:id/settle`.
- Relatório: vendas por canal agora mostram bruto − comissão = líquido previsto; `order_payment` do iFood passa a refletir o payout, não o bruto.

### 5.3 Frontend

- Nova tela "Conciliação" no manager (ou aba em relatórios) listando settlements pendentes, totais por canal, botão "marcar como recebido".
- Export CSV.

### 5.4 Testes

- Backend: registrar settlement; liquidar; recalcular relatório por canal.
- Frontend: render da tela com settlements pendentes e marcados.

**Arquivos**: `backend/migrations/0007_*.sql`, `backend/src/infra/db/schema.ts`, `backend/src/application/settlement/` (novo), `backend/src/http/routes/settlement.routes.ts` (novo), `backend/src/application/report.usecases.ts` (canal por liquidado), `frontend/src/pages/manager/tabs/settlement/` (novo), `backend/test/settlement.test.ts` (novo).

---

## Bloco 6 — Classificação de sangrias/suprimentos + alçadas (P1)

**Objetivo**: categoria obrigatória, destino/recebedor, alçada configurável.

### 6.1 Migration `0008_cash_movement_category.sql`

- `ALTER TABLE cash_drawer_movement ADD COLUMN category text` (cofre, troco, despesa, estorno, reforco, outro).
- `ALTER TABLE cash_drawer_movement ADD COLUMN recipient text` (destino/recebedor).
- `ALTER TABLE cash_drawer_movement ADD COLUMN receipt_ref text` (recibo/comprovante).
- `ALTER TABLE store_settings ADD COLUMN cash_movement_require_approval_above real NOT NULL DEFAULT 0`.

### 6.2 Backend

- `registerCashMovementUsecase` valida `category` obrigatório; `recipient` obrigatório quando category ∈ {despesa, outro}; `category='estorno'` só via sistema (não manual).
- Acima de `requireApprovalAbove`, exige `approvedBy` (PIN do gerente) — reaproveita a alçada do Bloco 1.

### 6.3 Frontend `CashMovementModal.jsx`

- Select de categoria obrigatório.
- Campo "destino/recebedor" aparece para despesa/outro.
- Campo "aprovador" aparece quando valor > alçada.

### 6.4 Testes

- Backend: sangria sem categoria → 422; sangria com valor alto sem aprovação → 422.
- Frontend: select de categoria obrigatório; campos condicionais.

**Arquivos**: `backend/migrations/0008_*.sql`, `backend/src/infra/db/schema.ts`, `backend/src/application/cash-flow/cash-flow.usecases.ts`, `backend/src/http/routes/cash-drawer.routes.ts`, `frontend/src/widgets/cash-drawer/CashMovementModal.jsx`, `backend/test/cash-flow.test.ts`.

---

## Ordem de execução

```
Bloco 1 (fechamento)   ─┐
                        ├── paralelizáveis, sem dependência entre si
Bloco 2 (serialização) ─┘
         │
         ▼
Bloco 3 (iFood bypass)    ─┐
                           ├── podem rodar em paralelo após Bloco 1
Bloco 4 (refund)          ─┘
         │
         ▼
Bloco 5 (settlement)  ──┐
                        ├── paralelizáveis
Bloco 6 (categorias)  ──┘
```

Cada bloco é **independente em PR** — a ordem é para reduzir risco, não dependência técnica.

## O que **NÃO** entra neste roadmap

- Home "Agora" do gerente (F1) — depende dos blocos acima para ter dados corretos; entra em feature posterior.
- Command Center em tempo real (F1) — idem.
- DRE (D2) — depende do Bloco 5 (settlement).
- Perfil `expeditor`, mapa de mesas, dividir/juntar/transferir — fora do escopo "caixa".

## Riscos conhecidos

- **Bloco 4 (refund)**: mudança no relatório pode quebrar tela do gerente. Revisar `report.usecases.ts` com cuidado.
- **Bloco 5 (settlement)**: pedidos iFood antigos ficarão sem settlement. Decisão: tratar como "não conciliado" no painel, sem forçar migration de dados.
- **Bloco 2.2 (idempotência em pagamentos)**: frontend atual não manda `correlationId`. A mudança é breaking no contrato — precisa versionar a rota ou aceitar corpo antigo (correlationId opcional com geração server-side).
