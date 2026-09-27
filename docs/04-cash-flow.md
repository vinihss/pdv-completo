# Fluxo de Caixa — Spec de Implementação

Documento do módulo de fluxo de caixa (abertura/ciência/estorno/fechamento e
resumo). Complementa `01-backend-spec.md` (§14 desta página na versão deste
módulo) e define o comportamento do caixa que os critérios de aceite em
`03-acceptance-criteria.md` §14 verificam.

## Conceito

O caixa é uma **sessão única por vez**: só existe um `cash_drawer` com
`status = 'open'` em `restaurant`/pub. Durante a sessão, o PDV acumula o
valor esperado em dinheiro — que é a soma de:

```
esperado = fundo inicial (opening_amount)
         + vendas em dinheiro confirmadas no período da sessão
         + suprimentos (entrada manual de notas/moedas)
         − sangrias (retirada manual ou estorno automático)
```

Fontes da verdade:
- `cash_drawer` (1 linha por sessão; fundo, quem abriu/fechou, resultado do fechamento).
- `cash_drawer_movement` (1 linha por sangria/suprimento; `ref_order_id` liga a movimentação a uma comanda de estorno).
- `order_payment` (`method='cash'`, `confirmed=true`) — a fonte das **entradas** de dinheiro de vendas, sempre re-consultada no cálculo, nunca denormalizada.

Cada perfil opera o caixa via papéis `cashier` e `manager` (a role `cashier`
é oferecida no login e na lista de usuários; ver `0013_add_cashier_role`). O
garçom continua podendo receber pagamento em dinheiro, mas **não** opera a
gaveta.

## Regras de corretude (o "hard block")

Decisões de produto desta rodada, todas cobertas por testes:

1. **Confirmação de dinheiro exige caixa aberto.** O bloco é aplicado **dentro
   da mesma transação** da escrita, nos dois caminhos de registro:
   - `PUT /orders/:id/payments` — cada linha com `method='cash'` e
     `confirmed=true` dispara a validação;
   - `PATCH /orders/:id/payments/:paymentId` (confirmar linha) — idem.
   Linhas em dinheiro **não confirmadas** (intenção de pagamento, fluxo do
   self-service/delivery) continuam permitidas sem caixa — só "recebeu o
   dinheiro de verdade" exige gaveta aberta.
   Erro: `409 cash_drawer_not_open` (factory `paymentRequiresOpenDrawer`).

2. **Estorno vira sangria automática.** Cancelar uma comanda que tenha linha de
   dinheiro confirmada (`cancelOrderUsecase`) grava um movimento `sangria` com
   o mesmo valor e `ref_order_id` apontando pra comanda, **na mesma
   transação** do cancelamento. Requer caixa aberto — se o caixa já foi
   fechado, o cancelamento responde `409 cash_drawer_not_open` (factory
   `cashRefundRequiresOpenDrawer`). A linha de pagamento **permanece**
   confirmada: o relatório mostra a venda e a sangria de reversão, então o
   esperado ao vivo volta ao valor anterior.

3. **Sangria não pode estourar o disponível.** Se `amount > esperado` a
   operação é recusada com `409 cash_withdrawal_exceeds_available` e
   `details.available` com o valor atual — impede caixa negativo.

4. **Sessão única e idempotência.** Segunda abertura → `409
   cash_drawer_already_open` (índice único parcial garante no banco). As
   operações usam `withIdempotency` com `correlationId` — replay não duplica
   e devolve a resposta cacheada.

## Endpoints

| Método | Rota | Papel | Corpo / Query |
|---|---|---|---|
| GET | `/cash-drawer/current` | cashier, manager | — → sessão aberta com `expectedCash`, vendas e movimentos, ou `null` |
| GET | `/cash-drawer` | cashier, manager | `limit`, `offset` → histórico de sessões |
| GET | `/cash-drawer/summary` | cashier, manager | `from`/`to` (`YYYY-MM-DD` ou ISO) e `tz?` (`±HH:MM`, fuso local) → sessões + totais do período |
| GET | `/cash-drawer/:id` | cashier, manager | — → uma sessão com vendas e movimentos |
| POST | `/cash-drawer/open` | cashier, manager | `{ correlationId, openingAmount, note? }` |
| POST | `/cash-drawer/sangria` | cashier, manager | `{ correlationId, amount, note? }` (exige caixa aberto) |
| POST | `/cash-drawer/suprimento` | cashier, manager | `{ correlationId, amount, note? }` (exige caixa aberto) |
| POST | `/cash-drawer/close` | cashier, manager | `{ correlationId, countedAmount, note? }` — `note` é a observação da conferência (`closing_note`), ex.: justificativa da variação |

Realtime: os eventos de caixa (`cash-drawer.open`, `.movement`, `.close`)
vão para o room `cash-drawer`, que o app do caixa/gerente assina via
`useRealtime`.

## Cálculo do fechamento

No `POST /cash-drawer/close`, a sessão é re-lida dentro da transação e o
esperado é recalculado no momento (não usa o valor exibido na tela), com:

```
closing_expected  = esperado calculado na transação do fechamento
closing_counted   = countedAmount informado
closing_difference = counted − expected
closing_note      = observação opcional da conferência (note do request)
```

Só o `cash_drawer` vira `closed`; nenhuma janela de conta pode ser confirmada
em dinheiro dali em diante até uma nova abertura. `closing_note` registra a
justificativa da variação (ex.: "emprestados R$ 2 para troco") — aparece no
detalhe da sessão, no log de auditoria do fechamento e no cupom impresso.

## Resumo por período (`/cash-drawer/summary`)

Retorna `{ sessions, totalOpening, totalSales, totalExpected, totalCounted,
totalDifference, openCount, openExpected }`. Uma sessão entra no período se
`opened_at <= to AND (closed_at >= from OR ainda aberta)`. **Os totais de
conferência somam apenas sessões fechadas** (`closing_expected`/`closing_counted`):
incluir o "esperado vivo" de uma sessão aberta junto com o contado das fechadas
distorceria a diferença consolidada. `openCount`/`openExpected` expõem o que
ainda não foi conferido; `totalOpening` e `totalSales` incluem as sessões em
aberto (o que já entrou de fato). No frontend, sessão aberta é exibida como
"em aberto" com o esperado atual — **nunca** como parte dos totais fechados.

Datas `YYYY-MM-DD` são interpretadas como um dia. Por padrão em UTC; com o query
`tz=±HH:MM` (offset do fuso da loja, ex.: `-03:00`), o dia começa/termina
deslocado — uma loja em GMT-3 não tem a sessão da madrugada dividida entre dois
"dias". Limitação documentada: DST usa o offset informado no request (sem
histórico por dia).

## Impressão do fechamento (cupom Z)

No client, o botão "Imprimir" do fechamento renderiza um `#print-root`
aninhado em qualquer ponto do DOM; a regra `@media print` em `index.css`
(isola `visibility` fora do `#print-root`) garante que **apenas** o cupom
sairá na impressão do navegador, com store-info (nome, cidade, chave Pix) +
movimentos + resumo. A impressão também está disponível no modal de detalhe
de uma sessão fechada do histórico.

## Testes

`backend/test/cash-flow.test.ts` (vitest) cobre: abertura/sessão única/403,
sangria/suprimento/fechamento e 409s, replay idempotente, hard block de
dinheiro sem caixa (PUT e PATCH/confirm), entrada ao vivo de dinheiro com
caixa aberto, estorno automático (sangria com `ref_order_id`) e o 409 de
estorno com caixa fechado, o resumo por período (totais só de sessões
fechadas + `openCount`/`openExpected` com sessão aberta no período), a
observação de conferência (`closing_note`), o `tz` inválido → 400 e os limites
de dia com offset (`day-bounds.ts`). Roda com `npm run test` no `backend/`
(Postgres dedicado `pdv_test` via `TEST_DATABASE_URL`, recriado no global setup).

Frontend: `frontend/` roda vitest (jsdom + Testing Library) com
`npm run test`. A lógica pura do relatório fica em
`src/features/reports/cashReportView.js` (linhas exibíveis sem `null.toFixed`,
totais do backend) e há regressão de render do `ReportsTab` com sessão aberta
no período — garante que o relatório nunca mais quebre.