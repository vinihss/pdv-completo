# Implementação Completa - Melhorias de Caixa

## Status: ✅ Mergeado na main (commit 2baaf318)

## Blocos Implementados (ROADMAP-CAIXA.md)

### Bloco 1 - Fechamento de caixa com contagem por denominação
- **Migration 0005**: `cash_drawer` com `closing_denominations`, `closing_justification`, `closing_approved_by`
- **Backend**: Validação de contagem (soma das cédulas deve bater), justificativa obrigatória acima da tolerância, aprovação de gerente para diferenças grandes
- **Frontend**: `CloseCashDrawerModal` reformulado com contagem por cédula/moeda, campo inicial vazio (sem pré-preenchimento), justificativa e aprovação condicionais
- **Testes**: 23 testes passando (cash-flow.test.ts)

### Bloco 2 - Serialização de transações e idempotência
- **Backend**: `findOpenDrawerTxForUpdate` com `SELECT FOR UPDATE` serializa sangrias, suprimentos, pagamentos e fechamentos
- **Idempotência**: endpoints PUT/PATCH/DELETE em `/orders/:id/payments` agora usam `withIdempotency` com `correlationId` (opcional por compatibilidade)
- **Teste de concorrência**: duas sangrias simultâneas cujo total excede o disponível → uma falha com 409
- **Testes**: 27 testes passando (incluindo teste de corrida)

### Bloco 3 - Correção do bypass iFood
- **Bug crítico**: `status-pushback.ts` inseria pagamentos iFood em dinheiro diretamente como `confirmed: true` sem verificar gaveta aberta
- **Correção**: verifica `findOpenDrawerTx` antes de confirmar; se gaveta fechada, grava como `confirmed: false` e gera alerta `ifood_cash_pending`
- **Timestamp**: `confirmedAt` agora usa `order.openedAt` (proxy do momento da venda) em vez do timestamp do webhook
- **Testes**: 7 testes passando (ifood-pushback.test.ts)

### Bloco 4 - Estorno com refund rastreável
- **Migration 0006**: tabela `order_refund` (refund de pagamento do PDV, distinta de `payment_refund` do gateway Pagar.me)
- **Backend**: `refundOrderPaymentUsecase` — dinheiro gera sangria automática com `ref_order_id` e refund `settled`; Pix/cartão geram refund `requested` (futuro: integração Pagar.me)
- **Relatório**: `listSalesUsecase` agora retorna `grossTotal`, `refundsTotal`, `netTotal` por pedido e no summary (`grossRevenue`, `totalRefunds`, `netRevenue`)
- **Testes**: 12 testes passando (refund.test.ts)

### Bloco 5 - Settlement iFood (separação bruto/líquido)
- **Migration 0007**: tabela `order_settlement` com `gross_amount`, `commission_amount`, `marketplace_fee`, `delivery_fee_subsidy`, `payout_amount`, `payout_status`
- **Backend**: `registerSettlementUsecase`, `markSettledUsecase`, `listSettlementsUsecase`, `getSettlementByOrderIdUsecase`
- **Endpoints**: POST/PATCH/GET `/settlements` (manager-only)
- **Frontend**: `SettlementTab` com lista, filtros (canal, status, período), totais; `RegisterSettlementModal` e `MarkSettledModal`; integração no `OrdersReportTab` mostrando bruto/estorno/líquido por pedido
- **Testes**: 13 testes passando (settlement.test.ts)

### Bloco 6 - Classificação de sangrias/suprimentos
- **Migration 0008**: coluna `category` em `cash_drawer_movement`, `cash_high_value_threshold` em `store_settings` (padrão R$ 500)
- **Backend**: validação de categoria obrigatória, exigência de aprovador (PIN de gerente) quando valor excede threshold
- **Frontend**: `CashMovementModal` com select de categoria obrigatório, campo condicional de aprovador, tratamento de erros específicos
- **Testes**: 12 testes passando (cash-flow-category.test.ts)

## Validações

- **Backend**: 71 testes passando (cash-flow, refund, settlement, ifood-pushback, cash-flow-category)
- **Frontend**: lint OK, build OK
- **Migrations**: 0005-0008 aplicadas com sucesso

## Decisões Arquiteturais

1. **`order_refund` vs `payment_refund`**: mantidos separados — o primeiro é refund do PDV (balcão), o segundo é refund do gateway Pagar.me
2. **Settlement separado de `order_payment`**: iFood bruto não contamina receita; payout líquido é conciliado separadamente
3. **Contagem por denominação**: campo inicial vazio força contagem física real, não cópia do esperado
4. **Serialização com FOR UPDATE**: transações serializadas previnem condições de corrida em sangrias simultâneas
5. **Idempotência com correlationId opcional**: compatibilidade com frontend antigo, geração server-side como fallback

## Arquivos Alterados

### Backend
- 4 migrations novas (0005-0008)
- Schema atualizado (`schema.ts`)
- Usecases: cash-flow.usecases.ts, order.usecases.ts, report.usecases.ts
- Novos módulos: refund/, settlement/
- Rotas: refund.routes.ts, settlement.routes.ts
- Tratamento de erros expandido (errors.ts)
- Testes expandidos: cash-flow.test.ts, helpers.ts
- Novos testes: ifood-pushback.test.ts, refund.test.ts, settlement.test.ts, cash-flow-category.test.ts

### Frontend
- Widgets: CloseCashDrawerModal.jsx, CashMovementModal.jsx, CashDrawerTab.jsx
- Páginas: SettlementTab.jsx, OrdersReportTab.jsx
- Entidades: settlement/ (api, model)
- Features: settlement/ (RegisterSettlementModal, MarkSettledModal)
- API client: cash.js atualizado

## Próximos Passos (fora do escopo deste merge)

- Integrar refund Pix/cartão com Pagar.me (usar `payment_refund` existente)
- DRE por dia de operação (D2) — depende de settlement
- Perfil `expeditor` + tela Passe (C1)
- Hub de canais (E1) — generalizar iFood para múltiplos marketplaces
