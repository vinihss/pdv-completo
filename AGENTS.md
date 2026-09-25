# AGENTS.md — PDV Restaurante/Pub

Guia para agentes e desenvolvedores que trabalham neste repositório. Leia este
arquivo antes de editar código. As specs em `docs/` são a fonte da verdade do
produto; este arquivo é o guia de trabalho e o plano de melhorias.

## Visão rápida do projeto

PDV (ponto de venda) para restaurante/pub, cobrindo o ciclo: abrir comanda →
lançar itens → (opcionalmente) cozinha prepara → garçom entrega → fechar conta.
Escopo da Etapa 1 é deliberadamente enxuto: sem ficha técnica, sem pagamento
automático, sem emissão fiscal. Controle de estoque **simples** (por produto,
com `track_stock`) existe e é opcional via `store_settings.inventory_enabled` —
ver `docs/07-estoque.md`.

O mesmo produto atende perfis diferentes por **configuração**, não por código
separado: restaurante tradicional (mesas + cozinha) ou pub (cliente/rótulo,
sem cozinha) — controlado pelos toggles `uses_tables` e `kitchen_enabled` em
`store_settings`.

### Estrutura

```
backend/    API REST + WebSocket (Node.js + TypeScript + Fastify + Drizzle + SQLite)
frontend/   App React (Vite) — login, garçom, cozinha, gerente — instalável como PWA
deploy/     Deploy em nuvem: Dockerfiles, Caddy (HTTPS automático), docker-compose
docs/       Specs originais (backend, frontend, critérios de aceite)
```

### Documentos de referência

| Arquivo | Conteúdo |
|---|---|
| `docs/00-overview.md` | Contexto do produto e decisões-chave. Se divergir da spec detalhada, a spec manda. |
| `docs/01-backend-spec.md` | Schema, arquitetura em camadas, API REST, WebSocket, concorrência, idempotência, Pix, auditoria, setup, requisitos não-funcionais. |
| `docs/02-frontend-spec.md` | Fluxos de garçom, cozinha e gerente, tela por tela. |
| `docs/03-acceptance-criteria.md` | Critérios de aceite em formato Dado/Quando/Então. |
| `docs/07-estoque.md` | Spec do controle de estoque: ledger `stock_movement`, flags de rollout, endpoints, regras de corretude e testes. |

## Como rodar

Requer Node.js 20+.

### Backend

```bash
cd backend
npm install
cp .env.example .env      # ajuste JWT_SECRET em produção
npm run seed               # cria banco SQLite + dados de demonstração
npm run dev                # http://localhost:3000
```

Usuários de teste (seed de dev — nunca rode em produção):

| Nome | Perfil | PIN |
|---|---|---|
| Ana Ribeiro | Garçom | 1234 |
| Carlos Lima | Garçom | 5678 |
| Roberto Alves | Gerente | 9999 |
| Caixa Teste | Caixa | 2468 |
| Entregador Teste | Entregador | 1357 |
| Estação Cozinha | Cozinha | 0000 |

### Perfis de acesso

O mesmo código cobre 5 perfis, cada um com sua superfície no login e seus
papéis no JWT (`backend/src/http/middlewares/auth.middleware.ts`): `waiter`,
`kitchen`, `manager`, `cashier` e `courier`. O login lista os usuários ativos
via `GET /auth/users`, que respeita os toggles de rollout — `kitchen_enabled:
false` esconde a cozinha e `uses_delivery: false` esconde os entregadores
(paridade por configuração, ver `00-overview.md`).

| Perfil | Telas apps | Rooms de realtime | Restrictions (backend) |
|---|---|---|---|
| waiter | Comandas | `waiter:{id}` + `kitchen-display` | comandas (criar/editar/fechar) |
| kitchen | Cozinha | `kitchen-display` | só marcar itens prontos |
| manager | Comandas + Configurações + Dinheiro + Entregar + Relatórios + Estoque + Auditoria + Equipe | `waiter:{id}` + `kitchen-display` + `cash-drawer` + `deliveries` + `inventory` | tudo (usa `kitchen-display` como room-broadcast de comandas) |
| cashier | Dinheiro (gaveta de caixa) | `cash-drawer` | fluxo de caixa (`cash-flow.routes.ts`); 403 em gerência/comandas |
| courier | Entregas | `deliveries` | só as entregas atribuídas a ele (`courier.routes.ts`); dispatch/deliver/fail |

Rotas por perfil: `waiter`/`manager` em `order.routes.ts`, `kitchen` em
`kitchen.routes.ts`, `cashier`/`manager` em `cash-flow.routes.ts`, `courier` em
`courier.routes.ts`, `manager` **exclusivo** em `delivery-manager.routes.ts` /
`/users` / `/audit-log` / cadastros. O manager também atende `waiter:{id}` —
ele enxerga as comandas na mesma tela do garçom.

Health check: `GET http://localhost:3000/health`

### Frontend

Em outro terminal:

```bash
cd frontend
npm install
npm run dev                # http://localhost:5173
```

O Vite já proxeia `/api` e `/realtime` para `localhost:3000` (`vite.config.js`).
O app é PWA instalável (ver `frontend/public/manifest.json`).

### Deploy

Ver o runbook completo em `deploy/README.md` (Docker Compose + Caddy com HTTPS
automático, backup do banco, seed de produção). Build de produção do frontend:
`npm run build` (gera `dist/`, serve atrás de proxy reverso que encaminhe `/api`
e `/realtime` pro backend).

### Comandos úteis

| Comando | Onde | O que faz |
|---|---|---|
| `npm run dev` | backend | roda com `tsx watch` |
| `npm run build` | backend | `tsc` → `dist/` |
| `npm run start` | backend | roda `dist/http/server.js` |
| `npm run seed` | backend | seed de dev (usuários/PINs fictícios) |
| `npm run seed:prod` | backend | seed de primeiro deploy (sem dados fictícios) |
| `npm run db:migrate` | backend | aplica `migrations/*.sql` manualmente (também roda no boot em modo local) |
| `npm run test` | backend | vitest (banco dedicado `data/test.db`; caixa, comandas, idempotência, maintenance, stock) |
| `npm run lint` | frontend | oxlint |
| `npm run build` | frontend | build de produção (Vite) |
| `npm run test` | frontend | vitest (jsdom + Testing Library; relatório de caixa/reports) |

## Convenções e regras ao editar código

Idioma do repositório: **PT-BR** (docs, comentários, UI, mensagens).

### Backend

- **ESM + NodeNext**: imports com extensão `.js` (ex.: `from "../infra/db/client.js"`).
- **Camadas**: `src/domain/` (erros), `src/application/` (use cases), `src/infra/`
  (db, realtime, audit), `src/http/` (rotas, middlewares), `src/config/` (env).
- **Transações SQLite são síncronas**: o driver `better-sqlite3` não aceita
  callbacks assíncronos dentro de `db.transaction(...)`. Todo o código dentro de
  transações usa os métodos síncronos do Drizzle (`.run()`, `.get()`, `.all()`,
  `.sync()`) em vez de `await`. Ver a documentação em
  `src/application/order/order.usecases.ts:15-28`. Se o modo `cloud` (Postgres)
  for implementado, esse trecho volta a ser assíncrono.
- **Audit log + eventos outbox na mesma transação** da escrita de domínio.
  Sempre que criar/alterar algo relevante, registrar `logAction` e/ou
  `enqueueEvent` no mesmo `db.transaction`.
- **Erros**: usar `AppError` com código do catálogo em `src/domain/errors.ts`.
  O handler global (`src/http/server.ts`) converte para
  `{ error: { code, message, details } }`. Nunca deixar vazar erro cru (500
  interno) onde cabe um erro de domínio.
- **Pagamento fracionado**: a fonte da verdade do pagamento é `order_payment`
  (1 linha por forma); `order.payment_method` é só denormalizado de exibição.
  Fechamento exige ≥1 linha, todas `confirmed` e soma == total (erros
  `payment_not_registered`/`payment_not_confirmed`/`invalid_payment_total`). O
  relatório `byPaymentMethod` soma os pedaços — comandas antigas sem linhas
  caem no denormalizado (fallback de leitura). Endpoints: `PUT /orders/:id/
  payments`, `PATCH/DELETE /orders/:id/payments/:paymentId`; o `PATCH
  /orders/:id/payment` legado é adaptador de intenção única usado pelo
  self-service/delivery — não regredir esses dois fluxos.
- **Idempotência**: endpoints marcados (`POST /orders`,
  `POST /orders/:id/items`, `PATCH /orders/:id/close`, fluxo de caixa) devem usar
  `withIdempotency` com `correlationId`. `failed`/expirado reprocessa na mesma
  linha; `completed` válido devolve cache; corrida de insert nunca gera 500
  (ver roadmap 1.4). Chaves expiradas são purgadas pelo job de maintenance (2.5).
- **Lock otimista**: toda mutação de `order_item` via `PATCH
  /orders/:id/items/:itemId` exige `expectedVersion`; em conflito, responder
  `concurrency_conflict`.
- **Migrations**: toda mudança de schema exige um novo arquivo `.sql` numerado
  (zero-padded, ordem lexicográfica) em `backend/migrations/`. Rodam no boot em
  modo local e via `npm run db:migrate` em produção.
- **Estoque é ledger, não coluna denormalizada**: o saldo de um produto é a soma
  dos `quantity_delta` de `stock_movement` (`sale`/`refund`/`purchase`/
  `adjustment`). O débito acontece em `addItemsUsecase` **dentro da transação**
  (mesma `db.transaction` do insert do item), com check de saldo antes e
  `order_item.cost_price` snapshot do custo; `rollback` de lote é automático por
  `throw`. Refund em `deleteItem`/`cancelOrder` re-credita os `sale` do ledger
  (por `order_item_id`/`order_id`) — nunca decide pelo flag atual do produto.
  Movimentos manuais (`POST /stock/:productId/movements`) são idempotentes e
  viram `stock_movement_manual` no audit. API e regras em
  `src/application/stock/stock.usecases.ts`; doc em `docs/07-estoque.md`.
- **Não existe lint/typecheck configurado no backend hoje** — rode `npm run build`
  (`tsc`) para validar.

### Frontend

- **Sem lib de estado** (sem Redux/Zustand/React Query): server-authoritative.
  Padrão: mutation `await` + reload via REST; WS para refresh direcionado.
- **Realtime**: usar o hook `useRealtime(token, rooms, onEvent)` (`src/shared/hooks/useRealtime.js`).
  O token vai como **subprotocol** (`Sec-WebSocket-Protocol`), nunca na query
  string. Rooms: clients assinam `waiter:{userId}` + `kitchen-display`; o backend
  usa `kitchen-display` como room-broadcast do app de comandas (fechar/pagar/
  deletar/cancelar emitem para lá além de `table:{id}`); o manager também assina
  `inventory` (módulo de estoque) e o caixa/gerente assina `cash-drawer`.
  **Nunca** emitir evento relevante só para `table:{id}` — nenhum client assina
  esse room (ver 1.2).
- **Mutations**: aguardar e então recarregar; sem otimismo. Tratar erros de
  domínio com toasts (`src/components/Toast.jsx`).
- **UI em PT-BR**; ícones via `lucide-react`; estilos com Tailwind 4 (CSS-first).
- Rodar `npm run lint` (oxlint) antes de terminar.

### PWA / build

- Service worker registrado só em produção (`src/main.jsx`). `sw.js` ignora
  `/api` e `/realtime` (sempre rede) e faz cache-first de `/assets/*`.

## Roadmap priorizado de melhorias

O roadmap abaixo é o plano de evolução. Cada item tem causa e localização
(`arquivo:linha`) e um critério de verificação. Prioridade decrescente por fase;
dentro da fase, a ordem indicada.

### Fase 1 — Bugs de corretude (alta prioridade, sem mudar contratos de API)

| # | Melhoria | Localização | Verificação |
|---|---|---|---|
| 1.1 | ~~Relatório de vendas quebra ao filtrar~~ — ✅ feito: `sql\`... IN ${orderIds}\`` trocado por `inArray` em `report.usecases.ts`; filtro `productId` testado por API. | `backend/src/application/report.usecases.ts` | `GET /reports/sales` (com e sem `productId`) retorna resultado. |
| 1.2 | ~~Comanda fechada não some da lista~~ — ✅ feito: `order.closed`, `order.cancelled`, `order.payment_changed` e `order.item.removed` agora têm broadcast extra para `kitchen-display` (room que o `useOrders` do garçom/gerente assina) além de `table:{id}` — decisão: usar `kitchen-display` como room-broadcast do app de comandas, mesmo padrão já usado em `order.item.created`. | `backend/src/application/order/order.usecases.ts` | Fechar/deletar/pagar comanda num terminal e o outro atualizar via WS sem "Atualizar" manual. |
| 1.3 | ✅ `crypto.randomUUID()` em contexto HTTP na LAN — já resolvido: fallback completos em `frontend/src/shared/lib/uuid.js` (`newCorrelationId()`: `randomUUID` → `getRandomValues` → `Math.random`), e todos os `correlationId` passam por ele. | `frontend/src/shared/lib/uuid.js` | Abrir comanda a partir de `http://<ip-da-maquina>:5173`. |
| 1.4 | ~~Idempotência: `failed` → 409 permanente; `expires_at` nunca lido; race → 500~~ — ✅ feito: estado `failed` ou `expires_at` expirado reprocessa na mesma linha (sem colisão de PK); race check-then-insert detecta a colisão e devolve a resposta da vencedora. Cleanup de chaves via job (ver 2.5). | `backend/src/http/middlewares/idempotency.middleware.ts` | Replay de `correlationId` após falha server-side reprocessa; dois requests idênticos concorrentes não geram 500. Testado em `test/idempotency.test.ts`. |
| 1.5 | ~~Outbox dispatcher sem try/catch~~ — ✅ feito: ciclo isolado em `pollOutboxOnce()` com catch por evento; payload corrompido é descartado (marca publicado + warn), o processo jamais derruba. | `backend/src/infra/realtime/outbox-dispatcher.ts` | Corromper payload de `outbox_event` e observar o processo continuar vivo (teste em `test/maintenance.test.ts`). |
| 1.6 | ~~`openOrderUsecase` não valida existência/status da mesa~~ — ✅ feito: dentro da transação, mesa inexistente → `404 table_not_found`; status ≠ `free` → `409 table_occupied`. | `backend/src/application/order/order.usecases.ts` | Abrir comanda em mesa ocupada → erro de domínio (não 500/duplicidade). Testado em `test/order-flow.test.ts`. |
| 1.7 | ~~`registerPaymentUsecase` muta comanda já fechada~~ — ✅ feito: valida `order_not_open` em todos os use cases de pagamento; `closeOrder` agora exige linhas `order_payment` confirmadas e soma == total (erros `payment_not_confirmed`/`invalid_payment_total`). Também resolveu de vez o fechamento com pagamento não confirmado. | `backend/src/application/order/order.usecases.ts:256-343` | Testes de API direta (curl) em comanda fechada e pagamento não confirmado retornam erros de domínio. |
| 1.8 | ~~Sem eventos realtime para delete de item e pagamento~~ — ✅ feito: `order.item.removed` (novo) e `order.payment_changed` broadcast para `table:{id}` + `kitchen-display` (ver 1.2). | `backend/src/application/order/order.usecases.ts:244-289` | Deletar item/pagar numa tela e ver a outra refletir via WS. |

### Fase 2 — Robustez operacional e segurança

- **2.1 ~~Rate limit por IP real~~** — ✅ feito: `trustProxy: 1` no Fastify
  (`backend/src/http/server.ts:22`); atrás do Caddy, `req.ip` passa a ser o IP
  real do client via `X-Forwarded-For`. Se adicionar outro hop de proxy, revisar
  o número de hops.
- **2.2 ~~`JWT_SECRET`~~** — ✅ feito: `backend/src/config/env.ts` falha no boot
  em produção (NODE_ENV=production ou modo cloud) se `JWT_SECRET` estiver
  ausente, for `"dev-secret-change-me"` ou tiver menos de 32 chars. Em dev local
  o fallback continua valendo.
- **2.3 ~~WebSocket: token na query string + join sem autorização~~** — ✅ feito:
  token passa a chegar via subprotocol `Sec-WebSocket-Protocol`
  (`frontend/src/shared/hooks/useRealtime.js`, `backend/src/http/routes/realtime.routes.ts`)
  — some dos logs de proxy; e `join` dinâmico é autorizado por papel
  (`canJoinRoom`: waiter/manager → `waiter:{sub}`/`kitchen-display`/`deliveries`,
  kitchen → `kitchen-display`, cashier → `cash-drawer`, courier → `deliveries`);
  room não permitido responde `join.denied`.
- **2.4 ~~`GET /audit-log` sem restrição~~** — ✅ feito: `requireRole("manager")`
  em `backend/src/http/routes/misc.routes.ts`.
- **2.5 ~~Cleanup~~** — ✅ feito: `backend/src/infra/maintenance.ts` —
  `runMaintenanceOnce()` purga `outbox_event` publicado com >1h e
  `idempotency_key` com `expires_at` passado; job de 5min no `main()` do
  `server.ts`. Testado em `test/maintenance.test.ts`.
- **2.6 ~~Remover artefato~~** — ✅ feito: `backend/data-docker-test/` removido
  (banco SQLite de teste commitado). Tudo que é runtime/local está no
  `.gitignore` da raiz (`*.db*`, `backend/data/`, `.env`).

### Fase 3 — Qualidade e refactor

- **3.1 Testes**: ✅ backend coberto por vitest (banco `data/test.db` limpo no global setup; suítes `backend/test/cash-flow.test.ts` — fluxo de caixa: sessão única, sangria/suprimento/fechamento, idempotência, hard block de dinheiro sem caixa, estorno automático e resumo por período incluindo `openCount`/`openExpected` e `closing_note`/`tz`; `test/order-flow.test.ts` — validação de mesa (1.6) e eventos outbox de fechamento/cancelamento/pagamento/delete (1.2/1.8); `test/idempotency.test.ts` — retry de `failed`/expirado, 409 processing, cache de completed (1.4); `test/maintenance.test.ts` — outbox corrompido não derruba (1.5) e cleanup (2.5); `test/profiles.test.ts` — perfis caixa/entregador: filtro de login por `kitchen_enabled`/`uses_delivery`, acesso por papel (403 em gerência/comandas), cadastro de entregador pelo gerente com PIN e fluxo complete assign → dispatch → deliver fechando a comanda). ✅ frontend também: vitest + jsdom + Testing Library (rodar `npm run test` no `frontend/`), com a lógica pura de `reports/cashReportView.js` e regressão de render do `ReportsTab` com sessão de caixa aberta no período. Ainda falta: cobrir os fluxos críticos de UI (login, entrega, fechamento com item pendente).
- **3.2 Lint/typecheck no backend** (hoje só `tsc` no build, sem lint).
- **3.3 N+1 em `listOrdersUsecase`**: 4 queries por comanda
  (`order.usecases.ts:358`) — trocar por join em lote.
- **3.4 Remover código/deps mortas**: `react-router-dom` (não usado);
  `order_item.status='cancelled'` sem código que o define;
  `ordersRef` em `useOrders.js`; `SYNC_ENABLED`/`syncTargetUrl` lidas mas não
  usadas (decisão consciente — ver Fase 4).
- **3.5 Debounce no filtro de cliente do relatório**
  (`frontend/src/screens/ManagerApp.jsx:538-554`).
- **3.6 Divergências de spec na UI**: navegação pós-lote volta para a lista
  (spec §4.4) em vez de ficar no detalhe; ~~QR Pix (BR Code) client-side~~ ✅
  feito (ver 4.4); som na cozinha; auditoria acessível ao garçom (spec §4.4.1).

### Fase 4 — Features pendentes da spec (fora do escopo atual)

- **4.1 Modo `cloud` (Postgres)**: hoje só `local` (SQLite); o "mesmo código
  para os dois drivers" não se sustenta dentro de transações síncronas —
  planejar o retorno a async ao implementar.
- **4.2 `SYNC_ENABLED`**: backup do SQLite em modo local (lacuna já sinalizada
  na spec §15 e no `README.md`).
- **4.3 Buffer de eventos no reconnect do WS**: `sync.request` responde vazio
  (`realtime.routes.ts:35-37`); client recarrega via REST, mas não é o sync
  completo da spec §8.
- **4.4 ~~QR Pix (BR Code)~~** — ✅ feito: `frontend/src/lib/pix.js` gera o BR
  Code (EMV + CRC-16/CCITT-FALSE) no client; o `PaymentModal` de
  `WaiterApp.jsx` registra `confirmed:false`, exibe o QR a partir de
  `store_settings.pix_key`/`merchant_name`/`merchant_city` e confirma com
  `confirmed:true`. Sem chave/nome/cidade configurados, a opção Pix fica
  desabilitada com aviso.

### Fase 5 — Estoque (implementado)

- **5.1 Ledger de estoque** — ✅ feito: `stock_movement` é a fonte da verdade do
  saldo (Σ `quantity_delta`; tipos `sale`/`refund`/`purchase`/`adjustment`), com
  `inventory_enabled` (store_settings) + `track_stock` (produto) como flags de
  rollout (padrões desligados — instalações existentes não mudam). Débito/
  bloqueio em `addItemsUsecase` dentro da transação (`insufficient_stock` com
  `details.available`), refund no delete/cancel via ledger, custo snapshot em
  `order_item.cost_price`, margem por produto no relatório. Doc em
  `docs/07-estoque.md`; suíte `test/stock.test.ts` (10 testes).
- **5.2 UI de estoque** — ✅ feito: aba "Estoque" no gerenciador (visível só com
  `inventory_enabled`) em `frontend/src/features/inventory/` (StockTab,
  MovementModal, MovementsList), badge de estoque baixo na listagem de produtos,
  campo de estoque no cadastro (com `initialStock` no create), bloqueio de item
  sem estoque na tela de lançamento do garçom e seção "Por produto" no relatório.
  Realtime no room `inventory` (`stock.movement`/`stock.low`).

## Critérios de verificação gerais

Antes de dar qualquer mudança por feita:

1. Backend: `npm run build` (tsc) sem erros.
1.1. Backend: `npm run test` (vitest) sem falhas — obrigatório quando o fluxo
   alterado tiver suíte (fluxo de caixa e estoque hoje).
2. Frontend: `npm run lint`, `npm run build` e `npm run test` sem erros.
3. Smoke manual por perfil: login (garçom/gerente/cozinha) → abrir comanda →
   lançar itens → (cozinha marca pronto) → garçom entrega → pagar → fechar.
4. Conferir o critério de aceite correspondente em
   `docs/03-acceptance-criteria.md`.
5. Toda mudança realtime: garantir que o evento chega a um room que o client
   realmente assina (ver Fase 1.2).
6. Toda mudança de schema: novo arquivo `.sql` numerado em `backend/migrations/`.
