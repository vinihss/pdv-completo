# AGENTS.md — PDV Restaurante/Pub

Guia para agentes e desenvolvedores que trabalham neste repositório. Leia este
arquivo antes de editar código. As specs em `docs/` são a fonte da verdade do
produto; este arquivo é o guia de trabalho e o plano de melhorias.

## Visão rápida do projeto

PDV (ponto de venda) para restaurante/pub, cobrindo o ciclo: abrir comanda →
lançar itens → (opcionalmente) cozinha prepara → garçom entrega → fechar conta.
Escopo da Etapa 1 é deliberadamente enxuto: sem estoque, sem pagamento
automático, sem emissão fiscal.

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
| Estação Cozinha | Cozinha | 0000 |

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
| `npm run lint` | frontend | oxlint |
| `npm run build` | frontend | build de produção (Vite) |

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
- **Idempotência**: endpoints marcados (`POST /orders`,
  `POST /orders/:id/items`, `PATCH /orders/:id/close`) devem usar
  `withIdempotency` com `correlationId`.
- **Lock otimista**: toda mutação de `order_item` via `PATCH
  /orders/:id/items/:itemId` exige `expectedVersion`; em conflito, responder
  `concurrency_conflict`.
- **Migrations**: toda mudança de schema exige um novo arquivo `.sql` numerado
  (zero-padded, ordem lexicográfica) em `backend/migrations/`. Rodam no boot em
  modo local e via `npm run db:migrate` em produção.
- **Não existe lint/typecheck configurado no backend hoje** — rode `npm run build`
  (`tsc`) para validar.

### Frontend

- **Sem lib de estado** (sem Redux/Zustand/React Query): server-authoritative.
  Padrão: mutation `await` + reload via REST; WS para refresh direcionado.
- **Realtime**: usar o hook `useRealtime(token, rooms, onEvent)` (`src/lib/ws.js`).
  Atenção aos rooms: hoje os clients assinam `waiter:{userId}` e
  `kitchen-display`. Eventos broadcast apenas para `table:{id}` **não chegam a
  nenhum client** — ver roadmap (1.2) e manter a consistência room/broadcast.
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
| 1.1 | Relatório de vendas quebra ao filtrar: `sql\`${orderItems.orderId} IN ${orderIds}\`` passa array cru ao template SQL (Drizzle expande sem parênteses). Trocar por `inArray` ou `sql.join` com parênteses. | `backend/src/application/report.usecases.ts:68` | Chamar `GET /reports/sales` (com e sem `productId`) e conferir resultado. |
| 1.2 | Comanda fechada não some da lista: `order.closed` e `table.status_changed` são broadcast só para `table:{id}`, room que nenhum client assina. Decidir entre fazer o client assinar o room ou broadcast extra para `kitchen-display`/`waiter:{id}`. | `backend/src/application/order/order.usecases.ts:327-336`; `frontend/src/lib/useOrders.js:55` | Fechar comanda num terminal e o outro atualizar via WS sem "Atualizar" manual. |
| 1.3 | `crypto.randomUUID()` indefinido em contexto HTTP na LAN (dev em `http://<ip>:5173`). Adicionar fallback (ex.: `Math.random`-based UUID) em `frontend/src/lib/api.js:18`. | `frontend/src/lib/api.js` | Abrir comanda a partir de `http://<ip-da-maquina>:5173`. |
| 1.4 | Idempotência: estado `failed` → 409 permanente; `expires_at` escrito mas nunca lido (sem cleanup); race check-then-insert → 500 (colisão de PK) em vez de 409. | `backend/src/http/middlewares/idempotency.middleware.ts` | Replay de `correlationId` após falha server-side; dois requests idênticos concorrentes. |
| 1.5 | Outbox dispatcher sem try/catch: payload corrompido → unhandled rejection → derruba o processo. | `backend/src/infra/realtime/outbox-dispatcher.ts:15-28` | Corromper payload de `outbox_event` e observar o processo continuar vivo. |
| 1.6 | `openOrderUsecase` não valida existência/status da mesa: permite 2 comandas abertas na mesma mesa; fechar uma libera a mesa com a outra aberta. Validar mesa existente e `free` (ou devolver erro de domínio). | `backend/src/application/order/order.usecases.ts:88-128` | Abrir comanda em mesa ocupada → esperar erro de domínio (não 500/duplicidade). |
| 1.7 | `registerPaymentUsecase` muta comanda já fechada (sem checagem de status); `closeOrder` valida só `paymentMethod`, não `paymentConfirmedAt`. | `backend/src/application/order/order.usecases.ts:256-343` | Testes de API direta (curl) em comanda fechada e pagamento não confirmado. |
| 1.8 | Sem eventos realtime para delete de item e pagamento → telas de colegas/cozinha defasadas. | `backend/src/application/order/order.usecases.ts:244-289` | Deletar item/pagar numa tela e ver a outra refletir via WS. |

### Fase 2 — Robustez operacional e segurança

- **2.1 ~~Rate limit por IP real~~** — ✅ feito: `trustProxy: 1` no Fastify
  (`backend/src/http/server.ts:22`); atrás do Caddy, `req.ip` passa a ser o IP
  real do client via `X-Forwarded-For`. Se adicionar outro hop de proxy, revisar
  o número de hops.
- **2.2 ~~`JWT_SECRET`~~** — ✅ feito: `backend/src/config/env.ts` falha no boot
  em produção (NODE_ENV=production ou modo cloud) se `JWT_SECRET` estiver
  ausente, for `"dev-secret-change-me"` ou tiver menos de 32 chars. Em dev local
  o fallback continua valendo.
- **2.3 WebSocket**: token na query string vaza em logs de proxy
  (`realtime.routes.ts:7`, `frontend/src/lib/ws.js:20`) — mover para
  header/`Sec-WebSocket-Protocol`. Qualquer usuário autenticado pode `join`
  qualquer room (`realtime.routes.ts:29-31`) — autorizar rooms.
- **2.4 `GET /audit-log`** sem restrição de papel, apesar de a spec tratar como
  ferramenta do gerente — adicionar `requireRole("manager")`.
- **2.5 Cleanup**: `outbox_event` publicado e `idempotency_key` crescem sem
  limite (e `expires_at` nunca é respeitado) — job de expiração/limpeza.
- **2.6 ~~Remover artefato~~** — ✅ feito: `backend/data-docker-test/` removido
  (banco SQLite de teste commitado). Tudo que é runtime/local está no
  `.gitignore` da raiz (`*.db*`, `backend/data/`, `.env`).

### Fase 3 — Qualidade e refactor

- **3.1 Testes**: configurar framework de testes (backend e frontend, a decidir)
  cobrindo ao menos os bugs da Fase 1 e os fluxos críticos
  (login, abrir/lançar/entregar/pagar/fechar, bloqueio de fechamento com item
  pendente).
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
  (spec §4.4) em vez de ficar no detalhe; QR Pix (BR Code) client-side;
  som na cozinha; auditoria acessível ao garçom (spec §4.4.1).

### Fase 4 — Features pendentes da spec (fora do escopo atual)

- **4.1 Modo `cloud` (Postgres)**: hoje só `local` (SQLite); o "mesmo código
  para os dois drivers" não se sustenta dentro de transações síncronas —
  planejar o retorno a async ao implementar.
- **4.2 `SYNC_ENABLED`**: backup do SQLite em modo local (lacuna já sinalizada
  na spec §15 e no `README.md`).
- **4.3 Buffer de eventos no reconnect do WS**: `sync.request` responde vazio
  (`realtime.routes.ts:35-37`); client recarrega via REST, mas não é o sync
  completo da spec §8.
- **4.4 QR Pix (BR Code)**: campo `pix_key` existe em `store_settings`, mas não
  há endpoint/geração de QR.

## Critérios de verificação gerais

Antes de dar qualquer mudança por feita:

1. Backend: `npm run build` (tsc) sem erros.
2. Frontend: `npm run lint` e `npm run build` sem erros.
3. Smoke manual por perfil: login (garçom/gerente/cozinha) → abrir comanda →
   lançar itens → (cozinha marca pronto) → garçom entrega → pagar → fechar.
4. Conferir o critério de aceite correspondente em
   `docs/03-acceptance-criteria.md`.
5. Toda mudança realtime: garantir que o evento chega a um room que o client
   realmente assina (ver Fase 1.2).
6. Toda mudança de schema: novo arquivo `.sql` numerado em `backend/migrations/`.
