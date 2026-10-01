# Guia de Testes

Como rodar e adicionar testes no projeto.

## Backend

```bash
cd backend
npm run test
```

**Framework**: vitest 5 + PostgreSQL dedicado `pdv_test` (recriado no global setup via `TEST_DATABASE_URL`).

### Suítes (17 arquivos)

| Arquivo | Cobertura |
|---|---|
| `test/alerts.test.ts` | Central de alertas (25 testes): rollback, desempate de seq, público, rooms |
| `test/cash-flow.test.ts` | Fluxo de caixa: sessão única, sangria/suprimento/fechamento, idempotência, hard block, estorno, resumo |
| `test/catalog.test.ts` | Catálogo: CRUD produtos, categorias, ordenação, busca |
| `test/delivery-location.test.ts` | Geocoding, cache, cálculo de distância |
| `test/delivery-pricing.test.ts` | Cálculo de preço de entrega |
| `test/idempotency.test.ts` | Retry de failed/expirado, 409 processing, cache de completed |
| `test/maintenance.test.ts` | Outbox corrompido não derruba, cleanup |
| `test/outbox-dispatcher.test.ts` | Ciclo do dispatcher: publica, teto de 50, ordem `created_at`/`seq`, payload corrompido, dono único por advisory lock |
| `test/order-flow.test.ts` | Validação de mesa, eventos outbox de fechamento/cancelamento/pagamento/delete |
| `test/payment-lines.test.ts` | Linha de pagamento `confirmed` não some em reenvio do `PUT` (preserva/recusa/reescreve não confirmada) + regressão do P0 do caixa, no `PUT` e no legado |
| `test/pix-key.test.ts` | Canonicalização de chave Pix (6 testes) |
| `test/printer.test.ts` | Impressão: 404 vs 503, auto-print, resetState |
| `test/profiles.test.ts` | Perfis caixa/entregador: filtro de login, acesso por papel, fluxo completo |
| `test/purchase.test.ts` | Compras + custo médio móvel (7 testes) |
| `test/self-service.test.ts` | Página pública: carrinho, variações, grupos obrigatórios |
| `test/stock.test.ts` | Ledger de estoque (10 testes): débito, refund, bloqueio, margem |
| `test/team-customers.test.ts` | Clientes + equipe (12 testes): CRUD, endereços, PIN, foto |
| `test/whatsapp.test.ts` | WhatsApp: webhooks, dedupe, status (35 testes) |

### Padrões

- **Postgres dedicado**: o global setup recria o banco `pdv_test` antes de cada suíte
- **`resetState()`**: algumas suítes (printer) precisam resetar o estado entre testes (mesa compartilhada)
- **Stub HTTP**: printer usa stub na porta 3456; whatsapp usa stub da Graph em porta fixa apontada pelo `env` do `vitest.config.ts`

## Frontend

```bash
cd frontend
npm run test
```

**Framework**: vitest + jsdom + Testing Library.

### Suítes (34 arquivos)

| Cobertura | Arquivos |
|---|---|
| Casca do app + menu | `App.test.jsx`, `AppMenu.test.jsx` |
| Drawer/accordion | `Drawer.test.jsx`, `AccordionMenu.test.jsx` |
| Modal/header/variação | `Modal.test.jsx`, `ScreenHeader.test.jsx`, `VariationModal.test.jsx` |
| Login por PIN | `Login.test.jsx` (teclado físico, input do celular, Enter/botão, sem auto-envio) |
| Detalhe da comanda | `OrderDetail.test.jsx` |
| Modais de compra/equipe | `ProductModal.test.jsx`, `UserModal.test.jsx` |
| Caixa/reports | `CashierApp.test.jsx`, `ReportsTab.test.jsx` |
| Página pública | `CustomerMenuPage.test.jsx` (integração: pega ReferenceError de import perdido) |
| Sino de alertas | `AlertBell.test.jsx` (17 testes, fluxo completo com WS dublê) |
| Áudio | `shared/lib/audio.test.js` (9 testes) |
| useRealtime | `shared/hooks/useRealtime.test.jsx` (3 testes) |
| Config e boot desktop | `SettingsTab.test.jsx`, `BootGate.test.jsx` |
| Lógica pura | `reports/cashReportView.js`, `features/customer-menu/cartLogic.js` |
| Fronteiras FSD | `__tests__/fsd-boundaries.test.js` (35 casos) |

### Padrões

- **Mock de entity**: usar o padrão-preservar (`vi.mock` + `importOriginal`)
- **Mock declarativo da barrel esconde o resto da entity** (UI e model) e quebra o render
- **Teste de integração da página** (`CustomerMenuPage.test.jsx`) é o que pega ReferenceError de import perdido — `tsc`/build não pegam

## Printer (daemon Go)

```bash
cd printer/daemon
go test ./...
```

**Cobertura**: caminhos, config padrão, CORS, templates embutidos, health.

## Como adicionar novos testes

### Backend

1. Criar arquivo `test/<dominio>.test.ts`
2. Usar o global setup (banco `pdv_test` já é recriado)
3. Se precisar de estado limpo entre testes, usar `resetState()`
4. Para stub de HTTP, usar porta fixa (padrão: 3456 para printer, porta configurável para whatsapp)

### Frontend

1. Criar arquivo `src/**/__tests__/<Component>.test.jsx` ou `test/<dominio>.test.js`
2. Usar Testing Library (`render`, `screen`, `fireEvent`, `waitFor`)
3. Para mock de entity, usar `vi.mock` + `importOriginal`
4. Para testar lógica pura, criar arquivo `.test.js` sem DOM

### Printer

1. Criar arquivo `printer/daemon/*_test.go`
2. Usar `testing` padrão do Go
3. Para stub de TCP, usar `net.Listen` em porta aleatória

## Critérios de verificação

Antes de dar qualquer mudança por feita:

1. Backend: `npm run build` (tsc) sem erros
2. Backend: `npm run test` (vitest) sem falhas — obrigatório quando o fluxo alterado tiver suíte
3. Frontend: `npm run lint`, `npm run build` e `npm run test` sem erros
4. Smoke manual por perfil: login → abrir comanda → lançar itens → (cozinha marca pronto) → garçom entrega → pagar → fechar
5. Conferir o critério de aceite correspondente em `docs/03-acceptance-criteria.md`
6. Toda mudança realtime: garantir que o evento chega a um room que o client realmente assina
7. Toda mudança de schema: novo arquivo `.sql` numerado em `backend/migrations/`
