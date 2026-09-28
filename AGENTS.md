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
backend/    API REST + WebSocket (Node.js + TypeScript + Fastify + Drizzle + PostgreSQL)
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
| `docs/08-estoque-profissional.md` | Spec do estoque profissional: fornecedores, compras multi-item, custo médio móvel, valorização, pendências (contagem, lote, multi-depósito). |
| `docs/10-whatsapp-embedded-signup.md` | WhatsApp Cloud API: Embedded Signup v4, token por WABA, webhooks de mensagem e de status, diagnóstico. |
| `docs/11-pix-pendencias.md` | BR Code do Pix: o que foi corrigido (GUI minúscula, txid alfanumérico, teto de 99 bytes) e as pendências (normalizar chave no save, `pixKeyType` morto, quiet zone, copia e cola). |

## Como rodar

Requer Node.js 20+.

### Backend

Precisa de um PostgreSQL 16 acessível (em dev, `docker compose -f
deploy/docker-compose.dev.yml up -d postgres` ou qualquer Postgres local).

```bash
cd backend
npm install
cp .env.example .env      # ajuste DATABASE_URL e JWT_SECRET
npm run seed               # aplica migrations + dados de demonstração
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
| waiter | Comandas | `waiter:{id}` + `kitchen-display` + `alerts` + `alerts:waiter` | comandas (criar/editar/fechar); cria cliente no balcão e busca clientes (`POST /customers`, `GET /customers/search`) |
| kitchen | Cozinha | `kitchen-display` + `alerts` + `alerts:kitchen` | só marcar itens prontos |
| manager | Comandas + Configurações + Dinheiro + Clientes + Entregar + Relatórios + Estoque + Auditoria + Equipe | `waiter:{id}` + `kitchen-display` + `cash-drawer` + `deliveries` + `inventory` + `alerts` + `alerts:manager` | tudo (usa `kitchen-display` como room-broadcast de comandas) |
| cashier | Dinheiro (gaveta de caixa) + Clientes | `cash-drawer` + `alerts` + `alerts:cashier` | fluxo de caixa (`cash-flow.routes.ts`) + manutenção de clientes; 403 em gerência/comandas |
| courier | Entregas | `deliveries` + `alerts` + `alerts:courier` | só as entregas atribuídas a ele (`courier.routes.ts`); dispatch/deliver/fail |

Rotas por perfil: `waiter`/`manager` em `order.routes.ts`, `kitchen` em
`kitchen.routes.ts`, `cashier`/`manager` em `cash-flow.routes.ts`, `courier` em
`courier.routes.ts`, `manager` **exclusivo** em `delivery-manager.routes.ts`
`/users` / `/audit-log` / cadastros. O manager também atende `waiter:{id}` —
ele enxerga as comandas na mesma tela do garçom. Clientes: `GET /customers`
(lista paginada), `GET /customers/:id` (detalhe + endereços), `PATCH
/customers/:id` (editar/soft-delete/reativar) e endereços
(`/customers/:id/addresses[/:addressId[/default]]`) são `manager`+`cashier`;
`POST /customers` (criar) aceita `waiter` também (balcão); `GET /customers/search`
é a busca leve do garçom (só ativos, sem email). Equipe: `POST/PATCH /users`
aceitam `phone`/`email`; `PATCH /users/:id` aceita `pin` manual (4-6 dígitos,
desbloqueia a conta); foto em `POST/DELETE /users/:id/photo` (mesmo padrão de
`product.image_path`).

Health check: `GET http://localhost:3000/health`

- **WhatsApp é token por WABA, não por instalação**: o que fica no ambiente
  (`META_APP_ID`/`META_APP_SECRET`/`WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`) é do
  **app da Meta**; o token do cliente vive em `whatsapp_connection` e **nunca
  sai por rota** (`GET /whatsapp/status` devolve só estado sem token). Uma WABA
  ativa por instalação (`uq_whatsapp_single_active`); reconectar a mesma atualiza
  a linha. Webhook em `/webhooks/whatsapp` (**fora** de `/api` — os três
  Caddyfiles e o `vite.config` têm rota `/webhooks/*` própria): assinatura
  `X-Hub-Signature-256` conferida sobre o **corpo cru** (`req.rawBody`), fan-out
  de todo o lote `entry × changes × messages`, dedupe por wamid
  (`whatsapp_inbound_message` — a Meta reenvia por ~7 dias), resposta 200 antes
  de processar, e status de saída casados por wamid em
  `whatsapp_outbound_message` (grava `order_id`). Erro da Meta vira
  `whatsapp_provider_error` (502), nunca 500 cru. Doc e diagnóstico em
  `docs/10-whatsapp-embedded-signup.md`; suíte `test/whatsapp.test.ts` (35
  testes, com stub da Graph em porta fixa apontada pelo `env` do
  `vitest.config.ts` — o `config` de `env.ts` é snapshot no load).

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
| `npm run db:migrate` | backend | aplica `migrations/*.sql` (também roda no boot em modo local) |
| `npm run db:deactivate-demo` | backend | desativa o cardápio fictício do `seed` (use `-- --dry-run` para só listar) |
| `npm run test` | backend | vitest 5 (Postgres dedicado `pdv_test` via `TEST_DATABASE_URL`; caixa, comandas, idempotência, maintenance, stock, whatsapp, printer, compras, clientes/equipe/perfis) |
| `npm run lint` | frontend | oxlint |
| `npm run build` | frontend | build de produção (Vite) |
| `npm run test` | frontend | vitest (jsdom + Testing Library; 29 suítes: casca do app + menu, drawer/accordion, modal/header/variação, login por PIN, detalhe da comanda, modais de compra/equipe, caixa/reports, página pública, **sino de alertas**, o áudio e o `useRealtime`) |

## Convenções e regras ao editar código

Idioma do repositório: **PT-BR** (docs, comentários, UI, mensagens).

### Backend

- **ESM + NodeNext**: imports com extensão `.js` (ex.: `from "../infra/db/client.js"`).
- **Camadas**: `src/domain/` (erros), `src/application/` (use cases), `src/infra/`
  (db, realtime, audit), `src/http/` (rotas, middlewares), `src/config/` (env).
- **PostgreSQL é o único banco** (o SQLite foi removido). `DATABASE_URL` é
  obrigatório e precisa ser `postgres://`/`postgresql://`; o pool é o
  `pg.Pool` (`DATABASE_POOL_MAX`, padrão 10).
- **Transações são assíncronas**: o `node-postgres` é I/O, então todo acesso
  dentro de `db.transaction` é `await tx...`. Os terminais síncronos do
  `better-sqlite3` (`.run()`, `.get()`, `.all()`, `.sync()`) **não existem** —
  query de 1 linha precisa de destructuring (`const [row] = await tx...returning()`)
  e agregação de `const rows = await ...` precisa de `rows[0]`. Ver a nota em
  `src/application/order/order.usecases.ts:15-28`.
- **Sem `rowid`**: ordem de inserção de `stock_movement`, `outbox_event` e
  `purchase_item` vem da sequência `seq BIGSERIAL` (a média móvel é um replay
  do ledger, então a ordem precisa ser estável). Não trocar por `created_at`.
- **Migrations**: o diretório tem **5 arquivos**, e o schema está **consolidado**
  — não procure os números antigos neste texto nem no histórico, eles não
  correspondem aos arquivos:
  | Arquivo | Conteúdo |
  |---|---|
  | `0001_init.sql` | **todo** o schema (tabelas, índices, extensões do app): inclui `order_payment`, `featured`, `unit_cost`, `purchase_item_id`, iFood, delivery, customer_address, geocoding_cache, cash_flow, estoque |
  | `0002_whatsapp_connections.sql` | token por WABA + tabelas de inbound/outbound |
  | `0003_printer.sql` | flags `printer_enabled` / `printer_auto_print` |
  | `0003_profile_fields.sql` | `user.phone/email/photo_path`, `customer.email/active`, extensão `unaccent` |
  | `0004_alerts.sql` | tabela `alert` (sino da casca): `seq`, `kind`, `title/body`, `order_id`, `channel`, `audience_roles`, `read_at` |

  Aplicadas pelo runner em `src/infra/db/migrate.ts` (advisory lock + tabela
  `_migrations`, uma transação por arquivo). Roda no boot em modo local e via
  `npm run db:migrate`.
- **Colisão `0003_*`**: o diretório tem **dois** arquivos `0003_*`
  (`0003_printer.sql` e `0003_profile_fields.sql`). É de propósito: o runner
  chaveia por filename em `_migrations.name`, e os bancos de dev **e de
  produção** já têm os dois registrados — **não renomear** (renomear tentaria
  reaplicar DDL e quebraria instalações existentes). Sempre que adicionar uma
  migration, use número zero-padded lexicograficamente **maior**; o próximo é
  `0005_*`.
- **Escreva migration idempotente**: use `ADD COLUMN IF NOT EXISTS` /
  `CREATE ... IF NOT EXISTS`. O runner já pula arquivos registrados, mas o DDL
  não pode estourar se a coluna tiver sido adicionada por fora dele. Como o
  boot agora **aborta** quando a migration falha (ver item seguinte), um DDL
  frágil derruba o container em vez de degradar em silêncio.
- **O boot falha se a migration falhar** (`src/http/server.ts`): `main()`
  aguarda `runMigrations()` dentro de `try/catch` e propaga o erro, saindo com
  `exit 1`. Antes era fire-and-forget (sem `await`) e o backend subia com o
  schema pela metade — health check 200 e 500 em runtime. **Não reintroduza o
  `runMigrations()` sem `await`.**
- **Build da imagem do backend**: `Dockerfile` faz `npm ci` + `npm prune
  --omit=dev` no estágio `build` (que tem `python3 make g++`) e a imagem final
  só copia o `node_modules` compilado. **Não reintroduza `npm ci --omit=dev` no
  estágio final**: o `drizzle-orm` declara `better-sqlite3` como peer
  dependency *opcional*, então o npm o instala mesmo com `--omit=dev` (marcado
  `devOptional` no lockfile) e o install script dispara o node-gyp, que estoura
  sem toolchain. O `better-sqlite3` é usado de verdade por
  `migrate-sqlite-to-pg.ts`, então não pode simplesmente sair do lockfile.
  Esse bug já quebrou um deploy em 28/09/2026: a versão anterior só compilava
  por **cache de layer** — sempre valide com `docker build --no-cache`.
- **Impressão térmica (daemon local, não fiscal)**: flags `printer_enabled`/
  `printer_auto_print` em `store_settings` (default off). O backend envia JSON
  estruturado para `PRINTER_DAEMON_URL` (default `http://127.0.0.1:8080`); o
  daemon renderiza ESC/POS e envia TCP para a impressora. Rotas
  manager/waiter em `print.routes.ts`: `POST /orders/:id/print` (manual,
  `{ destination: "kitchen" | "courier" }`), `GET /printers/status|health`.
  Auto-print é pós-commit **fire-and-forget** (nunca quebra o fluxo da
  comanda): cozinha no `addItemsUsecase` (só com modo cozinha ativo) e
  entregador no `dispatchDeliveryUsecase`. Semântica de erro: comanda
  inexistente → 404; daemon fora do ar → `service_unavailable` (503) — nunca
  confundir os dois. Suíte `test/printer.test.ts` com stub HTTP na porta 3456;
  **cada teste precisa de `resetState()`** (a mesa `t-1` compartilhada fica
  ocupada pelo teste anterior senão).
- **Central de alertas (sino da casca)**: tabela `alert` (migration `0004`),
  gravada em `openOrderUsecase` **dentro da transação da comanda** (mesma regra
  do audit/outbox: se o alerta falhasse fora, o gerente nunca ouviria a mesa que
  existe — o teste sabota o insert e prova o rollback). Três metades que
  precisam concordar:
  - **linha**: `createAlertTx` grava + faz o fan-out de `alert.created` por
    `enqueueEvent`, um insert de outbox por room da audiência;
  - **público**: `ORDER_ALERT_AUDIENCE` = `manager`/`cashier`/`kitchen`. O
    garçom **não** entra (em comanda de balcão ele é quem abriu), e o sino dele
    fica vazio — o que é informação, não bug;
  - **rooms**: `alerts` (alerta sem público) e `alerts:<papel>`. O
    `canJoinRoom` autoriza **o próprio papel** (`alerts:manager` para o
    gerente), nunca "o room de qualquer papel" — é o mesmo recorte do REST, e
    é o que impede o garçom de assinar o room do gerente.
  `read_at` é **global por loja** (não por usuário): a pergunta é "alguém já
  viu?", e quem responde é a tela da comanda (`OrderBoard` chama
  `POST /alerts/mark-read` com o `orderId` ao abrir). Rotas em
  `alert.routes.ts` **sem `requireRole`** — quem não tem audiência não recebe
  linha, e fechar por papel faria o sino sumir do garçom/entregador.
  `listAlertsUsecase` devolve `{ data, total, unread }` com `total`/`unread`
  do conjunto TODO (badge acima de 20 pendências tem que contar direito).
  O texto é função pura (`describeOrderAlert`) — mesma frase para balcão,
  página, WhatsApp e iFood. A listagem ordena por `(created_at, seq)`: o
  `created_at` é **texto com ms**, então dois alertas no mesmo milissegundo
  empatariam sem o `seq` (mesma razão do `outbox_event`) — o teste fixa o
  `created_at` das duas linhas e inverte a ordem do heap para provar o
  desempate. Purga de 7 dias no job de maintenance (2.5).
  Suíte `test/alerts.test.ts` (25 testes).
- **Contagem**: `count()` do Drizzle (nunca `sql<number>\`count(*)\`` — no
  Postgres o tipo bigint sai como string; se precisar de `count(*)` cru, caste
  `::int`). `sum(real)` devolve `number`.
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
  modo local e via `npm run db:migrate` em produção. Ao mudar o `0001_init.sql`
  (schema ainda em construção), recrie o banco de teste — o runner não re-aplica
  arquivo já registrado em `_migrations`.
- **Cardápio Unami (seed, não migration)**: `backend/seed-data/menu-unami.sql`
  carrega o cardápio do restaurante Unami (11 categorias, 63 produtos) a partir
  de `full_atualizado.md`. É **dado, não schema** — só `INSERT` com ID
  determinístico (`cat-unami-*` / `p-unami-NNN`) e `ON CONFLICT (id) DO UPDATE`
  restrito aos campos de catálogo (name/description/price/categoria/cozinha):
  reaplicar **não** sobrescreve `active`, `featured`, `cost_price`,
  `track_stock`, `unit` nem `variations` cadastrados depois no app. **Não roda
  automaticamente no boot** — é aplicado de forma explícita pelo script
  `backend/src/infra/db/load-menu.ts` (`node dist/infra/db/load-menu.js`),
  chamado pelo `deploy/install.sh` após o seed-prod.
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
- **Busca ignora acentos**: o backend usa a extensão `unaccent` do Postgres
  (migration `0003`) + normalização no app (`normalizeAccents` em
  `backend/src/domain/text.ts`); produtos, estoque e clientes buscam por nome
  sem distinguir acentos/case.
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
- **Botão de ação fora do `<form>`**: modais com footer irmão do form
  (`ProductModal`, `SupplierModal`, `MovementModal`, ...) devem vincular o
  botão por `form="<idForm>"` + `noValidate` no form — clique e Enter passam a
  submeter de verdade. Sem isso o botão não dispara submit e Enter "digita sem
  salvar" (regressão coberta em `footerSubmit.test.jsx`).
- **UI em PT-BR**; ícones via `lucide-react`; estilos com Tailwind 4 (CSS-first).
- **Variações de produto**: contrato único em `src/domain/variations.ts` (backend)
  e `VariationGroup` espelhado no menu público (`GET /public/menu` já devolve
  `required`/`allowMultiple`; o `normalizeVariations` do product continua
  re-exportado). O modal é **compartilhado**
  (`src/shared/components/VariationModal.jsx`, re-exportado em
  `src/features/orders/`); o garçom usa sem campo de observação. Regra de linha:
  chave = produto + variações, então o mesmo produto com escolhas diferentes são
  linhas separadas. Cliente valida no modal (UX) **e** o `POST /public/orders`
  barra grupo obrigatório ausente/inválido com 422 antes de qualquer escrita.
  Lógica pura do carrinho público em
  `src/features/customer-menu/cartLogic.js` (testada sem DOM): chave de linha,
  agrupamento por produto e grupos obrigatórios (a antiga "regra do stepper"
  saiu junto com `ProductStepper`).
- **Destaques da página pública**: `product.featured` (coluna no `0001_init.sql`,
  default `false`) alimenta a vitrine "Destaques" do `/pedido` — 3 colunas, card
  `ProductTile`; o produto continua na sua categoria (comportamento iFood). Marcado
  no cadastro (`ProductModal`, toggle "Em destaque na página de pedidos"; o campo
  só vai no payload quando o toggle existe — um edit com `uses_delivery` off não
  apaga a curadoria). O layout da página é o de loja do iFood: header com logo no
  meio, barra de busca + pills `sticky` que só aparece ao rolar (ou se não há o
  que rolar), pills por âncora (`scrollIntoView`) em vez de filtro, e a busca
  virando lista de "Resultados". Regra do scroll: a fonte é a coluna esquerda no
  desktop (`clientHeight > 0`) e o documento no celular.
- **Ficha completa antes de adicionar**: **não existe botão de "+"** nos cards —
  o clique abre o `VariationModal` compartilhado com `imagePath` + `showQuantity`
  (foto, variações, quantidade, total no CTA), para produto **com ou sem
  variação**. Os props são opcionais e desligados por padrão (o garçom continua
  com só as opções; `onConfirm(sel, notes, qty)` só recebe qty com
  `showQuantity`). `ProductStepper` foi removido (com `productStepperState`/
  `baseLineKey` do cartLogic). O card mostra badge "N no carrinho" e as linhas
  com variação (botões de linha levam produto + variação no `aria-label`).
- **Sem painel de carrinho fixo na lateral**: o "Seu pedido" sticky do desktop
  foi removido — página coluna única, carrinho aberto pela barra `fixed`
  (full-width no celular, `lg:right-8 lg:w-80` no desktop, cantos inferiores).
  Teste de integração da página (`CustomerMenuPage.test.jsx`) é o que pega
  ReferenceError de import perdido — `tsc`/build não pegam.
- **Sobreposição tem dono: `Modal`, `Drawer`, `ScreenHeader` ou `ConfirmModal`**
  (todos em `src/shared/components`, com teste próprio). Nada de overlay
  ad-hoc — se aparecer `fixed inset-0 bg-black/70` fora do `ConfirmModal` ou do
  `Drawer`, volta para um deles.
  - `Modal`: **tela cheia em qualquer device** (o tablet do garçom é o alvo):
    cabeçalho fixo com título e **X à direita**, corpo rolável, `footer` de ação
    sempre visível. Fecha por X, **Esc** ou **arrasto para baixo**. Cobre os
    ~18 modais do app (lançamento, revisão, pagamento, PIX, caixa, catálogo,
    estoque, compras, fornecedores, equipe e o cancelamento do pedido público).
  - `Drawer`: overlay **lateral** (painel que entra pela esquerda), o dono do
    menu principal no celular. Só a entrada é animada (`slide-in-left`).
  - `ScreenHeader`: telas que **já** são fullscreen (`OrderDetailScreen`,
    `AddItemScreen`) — mesma métrica do `Modal`, controle **à esquerda** (é
    navegação, não descarte) e Esc para voltar.
  - `ConfirmModal`: confirmação binária curta continua **card centralizado**
    (o peso do aviso vem do card); Esc cancela, `destructive` para exclusão.
  - Regras que valem para as duas camadas com `onClose`/`onBack`: o Esc passa
    por `useEscapeLayer` (`src/shared/hooks/useEscapeLayer.js`), que guarda uma
    **pilha de camadas** e entrega a tecla só ao topo — um listener por
    componente resolveria pela ordem de *registro*, e ela não é a ordem visual
    (efeito de filho roda antes do pai). Captura + `stopImmediatePropagation` +
    guarda de `repeat`/`defaultPrevented`; `Modal` e `Drawer` travam o scroll
    do fundo e restauram no unmount, e ambos usam os hooks compartilhados
    `useBodyScrollLock`/`useFocusTrap` (não reimplementar isso por conta
    própria). Gesto de descarte conservador: > 120px ou flick > 40px
    **e** > 0,6px/ms, trava de eixo em 8px, e corpo já rolado pertence ao
    scroll nativo.
  - `Modal` não pode formatar dinheiro (`formatBRL`/`.toFixed(2)` é proibido em
    `shared`): o pai formata e passa pronto. `PaymentModal.jsx` e
    `CloseCashDrawerModal.jsx` **não** movem de lugar — estão no allowlist
    `MONEY_ALLOWED` do `fsd-boundaries.test.js`.
  - `Section` (`shared/components/Form.jsx`) aceita `collapsed`/`onToggle`
    opcionais: com eles o cabeçalho vira botão de colapso (accordion de seção).
    Sem, é estático — não recriar esse comportamento ad-hoc.
- **Menu principal = accordion na esquerda, nos 5 perfis logados**
  (`widgets/app-menu/AppMenu.jsx`, dados em `app/providers/nav/menuSections.js`).
  - **Desktop (`lg`+)**: coluna de largura fixa ao lado do conteúdo — `w-72`
    (18rem) para quem tem o que expandir (o gerente) e **trilho de `w-16`**
    (4rem) para os perfis de tela única (garçom, cozinha, caixa, entregador),
    que não podem perder 288px por um menu de um item. `sticky top-14`, porque o
    header da casca é `h-14`.
  - **Mobile**: `Drawer` de tela cheia, aberto pelo botão `Menu` do header
    (`lg:hidden`, `aria-controls="app-menu-painel"`). Escolher uma tela fecha o
    painel; o rodapé do painel tem só a identidade de quem está logado — o
    "Sair" é um botão circular no canto direito do header e **não** é
    duplicado aqui (o scrim do painel é `fixed inset-0 z-50` e cobre o header
    `z-40`, então no celular ele só é alcançado com o painel fechado).
  - **Avatar das pessoas**: `UserAvatar` (`shared/components`) desenha a foto
    quando existe e as iniciais quando não — usada na grade do login, na tela
    do PIN e na identidade do menu. Não é só do login: `photoPath` vem em
    `GET /auth/users` e em `POST /auth/login` (a sessão guarda o objeto
    inteiro em `sessionStorage`), então quem está logado também tem foto.
  - **Regra de degeneração**: seção com **um** item não vira cabeçalho — o
    próprio item é a linha (nada de "Configurações" dentro de "Sistema"); menu
    sem nenhuma seção com 2+ itens vira trilho de ícones.
  - A seção da tela ativa começa aberta; mais de uma pode ficar aberta ao mesmo
    tempo (no desktop um 2º clique é caro).
  - **Quem guarda a tela ativa é o `NavProvider`**
    (`app/providers/nav/`), não a página: a casca (`app/router.jsx`, que
    desenha o menu) e a página do gerente são **irmãs** na árvore, então prop
    não resolve. Persiste por papel em `sessionStorage` (`pdv:nav:<role>`) — com
    a coluna sempre visível, voltar para "Comandas" a cada F5 seria um passo
    atrás. `id` guardado que não existe mais (toggle desligado) cai no
    primeiro item.
  - A antiga barra de abas do gerente **saiu**: `ManagerApp` é um mapa
    `SCREENS[activeId] ?? SCREENS.orders` e o badge de estoque baixo foi para
    `entities/stock/model/useLowStockCount.js` (`GET /stock` é
    `requireRole("manager")`, então o hook só busca para o gerente). O
    `AccordionMenu` soma os badges da seção no cabeçalho, para o sinal
    continuar visível com a seção recolhida.
  - Os chips de filtro do garçom e as estações da cozinha **continuam na
    lista** — o menu principal navega entre telas, não escolhe visão.
  - `shared/components/AccordionMenu.jsx` é burro de propósito: recebe as
    seções prontas e não sabe o que é comanda, estoque ou gerente (o vocabulário
    de domínio mora em `app/`, porque `shared` não pode carregá-lo).
- **Login por PIN tem duas vias de entrada, mesma regra** (só dígitos, corte em
  6): o keypad na tela e um input real sobre a linha de pontos com
  `inputMode="numeric"` + `autoComplete="one-time-code"` (teclado nativo do
  celular + físico). O envio é **explícito** — botão "Entrar" ou `Enter`;
  completar 6 dígitos **não** loga (PIN vai de 4 a 6) e o botão desabilita abaixo
  de 4. `Esc` volta para a seleção. Detalhe em `docs/02-frontend-spec.md` §3.
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
  (Postgres de teste via `TEST_DATABASE_URL`, banco recriado no global setup).
  Tudo que é runtime/local está no
  `.gitignore` da raiz (`*.db*`, `backend/data/`, `.env`).

### Fase 3 — Qualidade e refactor

- **3.1 Testes**: ✅ backend coberto por vitest (Postgres dedicado `pdv_test` recriado no global setup; suítes `backend/test/cash-flow.test.ts` — fluxo de caixa: sessão única, sangria/suprimento/fechamento, idempotência, hard block de dinheiro sem caixa, estorno automático e resumo por período incluindo `openCount`/`openExpected` e `closing_note`/`tz`; `test/order-flow.test.ts` — validação de mesa (1.6) e eventos outbox de fechamento/cancelamento/pagamento/delete (1.2/1.8); `test/idempotency.test.ts` — retry de `failed`/expirado, 409 processing, cache de completed (1.4); `test/maintenance.test.ts` — outbox corrompido não derruba (1.5) e cleanup (2.5); `test/profiles.test.ts` — perfis caixa/entregador: filtro de login por `kitchen_enabled`/`uses_delivery`, acesso por papel (403 em gerência/comandas), cadastro de entregador pelo gerente com PIN e fluxo complete assign → dispatch → deliver fechando a comanda). ✅ frontend também: vitest + jsdom + Testing Library (rodar `npm run test` no `frontend/`), com a lógica pura de `reports/cashReportView.js`, regressão de render do `ReportsTab` com sessão de caixa aberta no período, as primitivas de overlay (`Modal`/`ScreenHeader`/`ConfirmModal`) e o **login por PIN** (teclado físico, input do celular, `Enter`/botão, sem auto-envio em 6 dígitos). Ainda falta: cobrir os fluxos críticos de UI (entrega, fechamento com item pendente).
- **3.2 Lint/typecheck no backend** (hoje só `tsc` no build, sem lint).
- **3.3 N+1 em `listOrdersUsecase`**: 4 queries por comanda
  (`order.usecases.ts:358`) — trocar por join em lote.
- **3.4 Remover código/deps mortas**: `react-router-dom` (não usado);
  `order_item.status='cancelled'` sem código que o define;
  `ordersRef` em `useOrders.js` (~~`SYNC_ENABLED`/`syncTargetUrl`~~ removidas
  junto com o SQLite — ver Fase 4).
- **3.5 Debounce no filtro de cliente do relatório**
  (`frontend/src/screens/ManagerApp.jsx:538-554`).
- **3.6 Divergências de spec na UI**: navegação pós-lote volta para a lista
  (spec §4.4) em vez de ficar no detalhe; ~~QR Pix (BR Code) client-side~~ ✅
  feito (ver 4.4); som na cozinha; auditoria acessível ao garçom (spec §4.4.1).

### Fase 4 — Features pendentes da spec (fora do escopo atual)

- **4.1 Modo `cloud` (Postgres)**: o Postgres virou o único banco (o SQLite foi
  removido) — resta só padronizar o deploy com Postgres gerenciado.
- **4.2 Backup automático**: `deploy/backup.sh` faz `pg_dump` (é preciso agendar
  o cron e copiar pra fora do servidor).
- **4.3 Buffer de eventos no reconnect do WS**: `sync.request` responde vazio
  (`realtime.routes.ts:35-37`); client recarrega via REST, mas não é o sync
  completo da spec §8.
- **4.4 ~~QR Pix (BR Code)~~** — ✅ feito: `frontend/src/entities/payment/lib/pix.js`
  gera o BR Code (EMV + CRC-16/CCITT-FALSE) no client; o `PaymentModal` de
  `WaiterApp.jsx` registra `confirmed:false`, exibe o QR a partir de
  `store_settings.pix_key`/`merchant_name`/`merchant_city` e confirma com
  `confirmed:true`. Sem chave/nome/cidade configurados, a opção Pix fica
  desabilitada com aviso. **Corrigido em 28/09/2026**: o app do banco recusava
  o QR por GUI em maiúsculas (`BR.GOV.BCB.PIX`) e txid com hífen (`order.id` é
  `crypto.randomUUID()`); agora `analyzePixKey` canonicaliza a chave e deduz o
  tipo pelo formato, sem depender de `pixKeyType`. Pendências em
  `docs/11-pix-pendencias.md`.

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

### Fase 6 — Estoque profissional (fase 1: compras + custo médio)

- **6.1 Compras + custo médio móvel** — ✅ feito: `purchase`/`purchase_item`
  como documento multi-item (fornecedor, nota, lote/validade por linha),
  custo calculado por **média móvel ponderada** via replay do ledger
  (`computeMovingAverageTx`, `replayMovingAverage` em
  `backend/src/application/stock/stock.usecases.ts`), espelho em
  `product.cost_price`, snapshot em `order_item.cost_price` (só com
  `inventory_enabled && purchase_enabled && track_stock`; sem o módulo ligado,
  custo manual — paridade preservada), valorização em `GET /inventory/value`
  (média × saldo). `stock_movement.unit_cost` + `purchase_item_id` (colunas do
  `0001_init.sql`). Flags: `purchase_enabled` default off; compra de produto
  sem `track_stock` → 422. Idempotente via `correlationId`. Doc em
  `docs/08-estoque-profissional.md`; suíte `test/purchase.test.ts` (7 testes).
- **6.2 UI de compras** — ✅ feito: aba "Compras" no gerenciador (visível só com
  `purchase_enabled`) em `frontend/src/features/purchase/` (PurchaseTab,
  NewPurchaseModal, SupplierModal), campo Unidade no cadastro de produto
  (`product.unit`), toggle "Compras / fornecedores" nas configurações e cartão
  "Valorização do estoque" na aba Estoque. Realtime no room `inventory`
  (`purchase.received`).
- **6.3 Pendências** — contagem/inventário, lote/validade por saída (FIFO/FEFO),
  multi-depósito, ficha técnica, relatórios de compra — ver
  `docs/08-estoque-profissional.md` §Pendências.

### Fase 7 — WhatsApp (implementado)

- **7.1 Embedded Signup v4 (backend)** — ✅ feito: migration `0002`
  (`whatsapp_connection`, `whatsapp_outbound_message`,
  `whatsapp_inbound_message`, `whatsapp_conversation.waba_id`), token por WABA
  em texto puro, troca do code com validação de escopo via `debug_token`,
  descoberta de `phone_number_id` quando o postMessage não traz, `register` +
  `subscribed_apps` na ordem, `appsecret_proof` em toda chamada, uma WABA ativa
  por instalação. Rotas manager-only em `whatsapp.routes.ts`; doc em
  `docs/10-whatsapp-embedded-signup.md`; suíte `test/whatsapp.test.ts`.
- **7.2 Webhooks** — ✅ feito: assinatura conferida sobre o corpo cru, fan-out
  do lote, dedupe por wamid, roteamento por `phone_number_id` (cai na conexão
  ativa só quando não há `metadata`), token expirado marca a conexão,
  `messages.statuses` aplicado por wamid com log + evento no room `whatsapp`.
- **7.3 UI do gerente** — ✅ feito: aba `WhatsAppTab` em
  `pages/manager/tabs/whatsapp/` (card de estado, lista de variáveis faltando,
  histórico com status e motivo da falha, `ConfirmModal` para desconectar),
  `entities/whatsapp/` com a API e o `FB.login`/`postMessage` do Embedded
  Signup (extração testada em `embeddedSignup.test.js`, com checagem de
  `origin`), item no menu (`menuSections.js`) e no `SCREENS` do `ManagerApp`.
- **7.4 Pendências** — revogação do token na API da Meta ao desconectar
  (hoje o apagamento é local); reconciliação de `phone_numbers`;
  `quality_rating` na UI; templates de mensagem com aprovação da Meta.

### Fase 8 — Clientes, equipe e catálogo (implementado)

- **8.1 Manutenção de clientes (gerente/caixa)** — ✅ feito: `customer.email` +
  `customer.active` (soft-delete/reativação) na migration `0003`; CRUD completo
  em `customer.usecases.ts` (lista paginada com busca, detalhe com endereços,
  create/update com validação de email único); `customer_address` ganhou
  `setDefaultCustomerAddressUsecase` e `deleteCustomerAddressUsecase`
  (`self-service/customer-address.usecases.ts`). UI: aba "Clientes" no gerente
  (`pages/manager/tabs/customers/` — CustomersTab + CustomerModal com gestão
  de endereços: adicionar/excluir/marcar padrão) e no caixa (o `CashierApp`
  agora é um mapa de telas Caixa/Clientes — o menu do caixa virou coluna).
  Garçom segue criando cliente no balcão (`POST /customers`) e usando a busca
  leve `GET /customers/search`. Suíte `test/team-customers.test.ts` (12 testes).
- **8.2 Perfil completo de equipe** — ✅ feito: `user.phone`, `user.email`,
  `user.photo_path` na migration `0003`; create/update aceitam telefone/email;
  `PATCH /users/:id` aceita `pin` manual (além do `reset-pin` que gera
  aleatório); foto em `POST/DELETE /users/:id/photo` (mesmo padrão do produto).
  UI: `UsersTab` reescrita (avatar com foto/iniciais, telefone com máscara,
  email, busca, filtro por perfil) + `UserModal` (criação/edição com todos os
  campos e upload de foto).
- **8.3 Catálogo com colapso, filtros e busca sem acentos** — ✅ feito:
  produtos agrupados por categoria em accordion (Expandir/Recolher tudo,
  contagem por grupo, "Sem categoria" como bloco final); seção de categorias
  e grupos de produção colapsável (`Section` com `collapsed`/`onToggle`);
  busca com debounce de 250ms; novos filtros de ordenação (nome/preço) e botão
  "Limpar"; `GET /products` aceita `sort`. Busca sem acentos via extensão
  `unaccent` (produtos, estoque e clientes).

### Fase 9 — Impressão térmica (implementado)

- **9.1 Impressão local via daemon sidecar** — ✅ feito: flags
  `printer_enabled`/`printer_auto_print` (default off) em `store_settings` e
  daemon em Go (`printer/mock_server.go`) que recebe JSON estruturado via
  `POST /api/print` e envia ESC/POS por TCP. Backend envia para
  `PRINTER_DAEMON_URL` (default `http://127.0.0.1:8080`); rotas em
  `print.routes.ts` (manual por comanda, `status` e `health`). Auto-print
  fire-and-forget pós-commit: cozinha no lançamento de item e entregador no
  dispatch. Erros: 404 só pra comanda inexistente, 503 pra daemon fora do ar.
  UI: `PrintLayoutModal` compartilhado + botão no `OrderDetailScreen` + toggles
  em Configurações. Suíte `test/printer.test.ts` (10 testes). Nota de
  operação: em Docker, o backend alcança o daemon do host via `host_gateway`
  ou sidecar (`PRINTER_DAEMON_URL`).

### Fase 10 — Central de alertas (implementado)

- **10.1 Alerta de comanda no backend** — ✅ feito: tabela `alert` (migration
  `0004`) gravada por `createAlertTx` dentro da transação de
  `openOrderUsecase`, com fan-out `alert.created` para `alerts:<papel>`;
  `audience_roles` = `manager`/`cashier`/`kitchen` (o garçom não ouve a própria
  comanda de balcão). Rotas `GET /alerts` e `POST /alerts/mark-read` sem
  `requireRole`, com o recorte por papel dentro do usecase; `canJoinRoom`
  autoriza só o room do próprio papel. Texto em função pura
  (`describeOrderAlert`), retido 7 dias pelo job de maintenance. Suíte
  `test/alerts.test.ts` (25 testes) — inclui o teste de rollback (sabota o
  insert do alerta e prova que a comanda não é criada) e o de desempate do
  `seq` (empate de `created_at` não embaralha a ordem do sino).
- **10.2 Sino, contador e marcação de lido** — ✅ feito: `AlertBell` no header
  dos 5 perfis (drawer pela direita, sai por `createPortal` porque o header tem
  `backdrop-blur` e viraria containing block do `fixed`), badge com o `unread`
  do servidor (teto visual em `99+`), lista agrupada por dia que mostra as lidas
  também, e "marcar todas". `read_at` é global: `OrderBoard` chama
  `markRead(orderId)` ao abrir a comanda, por qualquer caminho. O clique navega
  só para quem tem a tela de comandas e só com comanda aberta; nos demais
  perfis (caixa/cozinha/entregador) ele só desmarca. `AlertsProvider` +
  `OrderFocusProvider` no `app/` porque casca e página são irmãs na árvore.
- **10.3 Som por tipo de alerta** — ✅ feito: Web Audio API sintetizado
  (`shared/lib/audio.js`, sem arquivo de áudio) com a tabela de tons por
  `alert.kind` em `entities/alert/lib/sounds.js`; toque no `alert.created` e
  **uma repetição após 30s** se o alerta continuar não lido (cancelada ao
  marcar lido, timers limpos no logout). Preferência `localStorage`
  `pdv:alert-sound`, **por aparelho**, com toggle no rodapé do drawer. O
  `AudioContext` só nasce depois de um gesto do usuário (listener único de
  `pointerdown`/`keydown` na casca), e navegador sem Web Audio só perde o som.
  Suítes: `AlertBell.test.jsx` (17 testes, fluxo completo com WS dublê),
  `shared/lib/audio.test.js` (9), `shared/hooks/useRealtime.test.jsx` (3) e
  `entities/alert` (19).
- **10.4 Recarga e pendências** — como o `pollOutboxOnce` marca publicado
  mesmo sem assinante na sala, o evento emitido durante uma queda de conexão
  **não volta**: o `useRealtime` ganhou um 4º argumento `onReconnect` (dispara
  só a partir da segunda abertura — a primeira é a montagem, que já carregou) e
  o `AlertsProvider` recarrega por GET nele, além de recarregar no
  `visibilitychange`. Testes: `useRealtime.test.jsx` (3) e o caso
  "reconexão recarrega a lista" em `AlertBell.test.jsx`.
- **10.5 Pendências** — evento de "alerta lido" no WS (o sino de outro terminal
  só reflete quando aquele terminal recarrega, recarrega por foco ou reconecta —
  não há push de `read_at`); `alertId` em `POST /alerts/mark-read` para marcar
  um alerta público isolado (hoje a ausência de `orderId` significa "todas");
  outros `kind` (estoque baixo, entrega parada).

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
