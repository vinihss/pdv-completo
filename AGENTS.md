# AGENTS.md — PDV Restaurante/Pub

Guia para agentes e desenvolvedores. As specs em `docs/` são a fonte da verdade do produto; este arquivo é o guia de trabalho.

## Visão rápida do projeto

PDV (ponto de venda) para restaurante/pub: abrir comanda → lançar itens → (opcionalmente) cozinha prepara → garçom entrega → fechar conta. O mesmo produto atende perfis diferentes por **configuração** (`store_settings`), não por código separado.

## Estrutura

```
backend/    API REST + WebSocket (Node.js + TypeScript + Fastify + Drizzle + PostgreSQL)
frontend/   App React (Vite) — login, garçom, cozinha, gerente — instalável como PWA
            (também é o bundle servido pelos apps standalone)
frontend/src-tauri/  App desktop v1 (Tauri) — desacoplado do web app, em manutenção
deploy/     Deploy em nuvem: Dockerfiles, Caddy (HTTPS automático), docker-compose
docs/       Specs originais + guias para agentes
printer/   Daemon Go para impressão térmica (ESC/POS)
```

## Documentos de referência

### Specs do produto

| Arquivo | Conteúdo |
|---|---|
| `docs/00-overview.md` | Contexto do produto e decisões-chave |
| `docs/01-backend-spec.md` | Schema, arquitetura, API REST, WebSocket, concorrência, idempotência, Pix, auditoria |
| `docs/02-frontend-spec.md` | Fluxos de garçom, cozinha e gerente, tela por tela |
| `docs/03-acceptance-criteria.md` | Critérios de aceite em formato Dado/Quando/Então |
| `docs/07-estoque.md` | Controle de estoque: ledger, flags, endpoints, regras |
| `docs/08-estoque-profissional.md` | Estoque profissional: fornecedores, compras, custo médio móvel |
| `docs/09-frontend-fsd.md` | Histórico das fases da migração para FSD no frontend |
| `docs/10-whatsapp-embedded-signup.md` | WhatsApp Cloud API: Embedded Signup v4, webhooks |
| `docs/11-desktop-instalador.md` | App Windows (Tauri): instalador, boot/update, daemon |
| `docs/11-pix-pendencias.md` | BR Code do Pix: por que o QR era recusado (GUI minúscula, txid, teto de 99 bytes) e o que ficou pendente |
| `docs/12-n-plus-one-list-orders.md` | Roadmap: eliminar N+1 em `listOrders` |
| `docs/13-deploy-workflow-melhoras.md` | Melhoras no workflow de deploy (versão, artefatos, publicação) |
| `docs/14-usabilidade-e-processos.md` | Backlog priorizado: fluxo de pedido, gestão e caixa (8 bugs de confiabilidade + 40 propostas em 8 camadas, roadmap P0-P5) |
| `docs/15-multi-tenant-schema.md` | Multi-tenant por **schema PostgreSQL** (subdomínio → tenant): arquitetura, decisões, fases e riscos |
| `docs/16-pendencias.md` | Pendências do planejamento multi-tenant + intenção de unificar migrations numa única baseline |

### Guias para agentes

| Arquivo | Conteúdo |
|---|---|
| `docs/agent-backend.md` | Convenções backend: camadas, transações, migrations, estoque, alertas, impressão |
| `docs/agent-frontend.md` | Convenções frontend: FSD, camadas, componentes, overlays, menu, Tauri |
| `docs/agent-deploy.md` | Deploy azul/verde: switch, healthcheck, regras, backup |
| `docs/agent-testing.md` | Como rodar testes: backend (17 suítes), frontend (34 suítes), printer |
| `docs/agent-api-index.md` | Índice de todos os endpoints da API, agrupados por domínio |
| `docs/agent-glossary.md` | Glossário de termos do domínio (BR Code, FSD, blue/green, …) |
| `docs/agent-backend-map.md` | Mapa arquivo→conteúdo do backend (onde mexer para cada assunto) |
| `docs/agent-frontend-map.md` | Mapa arquivo→conteúdo do frontend (idem, por feature) |

Os `agent-*.md` são os guias de entrada rápida: convenções e mapa de arquivos.
Os docs numerados são o detalhe — spec completa, histórico de decisão e o que
ficou pendente. Os dois conjuntos se complementam, não se substituem.

### Outros

| Arquivo | Conteúdo |
|---|---|
| `CHANGELOG.md` | Histórico de versões e fases do roadmap |
| `deploy/README.md` | Runbook completo de deploy (33 KB) |
| `printer/README.md` | Documentação do daemon de impressão |

## Como rodar

Requer Node.js 20+ e PostgreSQL 16.

### Backend

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

Health check: `GET http://localhost:3000/health`

### Frontend

```bash
cd frontend
npm install
npm run dev                # http://localhost:5173
```

O Vite já proxeia `/api` e `/realtime` para `localhost:3000` (`vite.config.js`). O app é PWA instalável.

### App desktop (Tauri)

O app v1 (`frontend/src-tauri/`, `com.pdvapp.desktop`, em produção) está
**desacoplado do frontend**: `frontend/` é só a aplicação web (e o bundle que os
apps standalone servem). Os scripts `desktop:*` saíram do `frontend/package.json`
(as deps de runtime `@tauri-apps/*` seguem lá) e a CLI `@tauri-apps/cli` mora
agora na **raiz do repo** (`node_modules/.bin/tauri`, `package.json` da raiz).

```bash
# a partir de frontend/
cd frontend
bash src-tauri/build-app.sh            # build local (instalador; sem sidecar — printer reestruturado)
bash src-tauri/build-app.sh --release  # build de entrega: exige chave de assinatura
../node_modules/.bin/tauri dev         # roda o app no desktop (CLI da raiz, cwd = frontend)
```

O script resolve os caminhos pela própria localização, então também vale
`bash frontend/src-tauri/build-app.sh` a partir da raiz do repo. Não existe mais
`npm run desktop:build` / `npm run desktop:dev`.

## Perfis de acesso

O mesmo código cobre 5 perfis, cada um com sua superfície no login e seus papéis no JWT (`backend/src/http/middlewares/auth.middleware.ts`): `waiter`, `kitchen`, `manager`, `cashier` e `courier`.

### App desktop (Tauri)

Duas armadilhas que já custaram tempo (detalhe em `docs/11-desktop-instalador.md` §8.1-8.2):

- **AppImage não empacota no Arch** — o `strip` do `linuxdeploy` não conhece a seção `.relr.dyn` das libs do Arch e o build morre with "failed to run linuxdeploy". The `.deb` sai normal; para o AppImage use `bash frontend/src-tauri/build-app.sh --appimage-docker` (empacota num `debian:bookworm-slim`).
- **Build local sempre pede chave de assinatura** — o Tauri 2 assina o artefato de update sempre que `plugins.updater.pubkey` está no conf, e nenhuma flag de `-c` desliga. Sem isso o build local terminava com erro *depois* de gerar o instalador. O script agora gera uma chave descartável em `frontend/src-tauri/.local-signing.key` (fora do git): o instalador sai, o `.sig` existe, e nenhum app real atualiza por ele — entrega continua exigindo `--release` com a chave de verdade.

O app Windows é o alvo: instalador único, config por loja em `%ProgramData%\PDV\app.json` e daemon de impressão instalado como serviço junto. **A lista do que ainda não foi provado (chave da assinatura fora do repo, secrets do deploy ausentes, `installer-hooks.nsh` nunca compilado) está em `docs/11-desktop-instalador.md` §9 — leia antes de chamar algo de "pronto".**

**O instalador tem um workflow só**: `.github/workflows/build-desktop.yml` (`workflow_call` + `workflow_dispatch`). O job `build-desktop` do `deploy-on-tag.yml` é só um `uses:` para ele. Regra ao mexer: **uma única definição de build** — se o passo de assinar, o `latest.json` ou o `scp` mudar, muda no `build-desktop.yml`, nunca em cópia. Duas armadilhas do `workflow_call`: `permissions: contents: write` precisa estar **no job que chama** (o token é a interseção das permissões, senão o `gh release create` falha no fim do run) e, no disparo manual, a release precisa de `--target ${{ github.sha }}` senão nasce no topo da branch padrão. Detalhe em `docs/11-desktop-instalador.md` §6.

| Perfil | Telas apps | Rooms de realtime | Restrictions (backend) |
|---|---|---|---|
| waiter | Comandas | `waiter:{id}` + `kitchen-display` + `alerts` + `alerts:waiter` | comandas (criar/editar/fechar); cria cliente no balcão e busca clientes |
| kitchen | Cozinha | `kitchen-display` + `alerts` + `alerts:kitchen` | só marcar itens prontos |
| manager | Comandas + Configurações + Dinheiro + Clientes + Entregar + Relatórios + Estoque + Auditoria + Equipe | `waiter:{id}` + `kitchen-display` + `cash-drawer` + `deliveries` + `inventory` + `alerts` + `alerts:manager` | tudo |
| cashier | Dinheiro (gaveta de caixa) + Clientes | `cash-drawer` + `alerts` + `alerts:cashier` | fluxo de caixa + manutenção de clientes; 403 em gerência/comandas |
| courier | Entregas | `deliveries` + `alerts` + `alerts:courier` | só as entregas atribuídas a ele |

O login lista os usuários ativos via `GET /auth/users`, que respeita os toggles de rollout — `kitchen_enabled: false` esconde a cozinha e `uses_delivery: false` esconde os entregadores.
## Comandos úteis

| Comando | Onde | O que faz |
|---|---|---|
| `npm run dev` | backend | roda com `tsx watch` |
| `npm run build` | backend | `tsc` → `dist/` |
| `npm run start` | backend | roda `dist/http/server.js` |
| `npm run seed` | backend | seed de dev (usuários/PINs fictícios) |
| `npm run seed:prod` | backend | seed de primeiro deploy (sem dados fictícios) |
| `npm run db:migrate` | backend | aplica `migrations/*.sql` (também roda no boot em modo local) |
| `npm run test` | backend | vitest 5, 17 suítes (Postgres dedicado `pdv_test`) |
| `npm run lint` | frontend | oxlint |
| `npm run build` | frontend | build de produção (Vite) |
| `npm run test` | frontend | vitest (jsdom + Testing Library; 34 suítes) |
| `bash src-tauri/build-app.sh` | frontend | build do app desktop v1 (Tauri); `--release` = entrega (chave de assinatura), `--appimage-docker` = AppImage |
| `node_modules/.bin/tauri <cmd>` | raiz | CLI do Tauri (na raiz do repo, não em `frontend/node_modules`; rodar com cwd=`frontend/` para o app v1) |
| `go test ./...` | `printer/daemon` | suíte do daemon |
| `./switch.sh` | deploy | deploy sem downtime (instância nova + `caddy reload`); `--status`, `--rollback`, `--install`, `--no-build` |
| `./probe-availability.sh --url <url> --seconds N` | deploy | mede o gap de downtime real (sai != 0 se houve falha) |
| `./scripts/dev-worktree.sh new <branch>` | raiz | cria o worktree de trabalho em `~/pdv-worktrees/<branch>`, a partir da `origin/main` já atualizada |
| `./scripts/dev-worktree.sh list` | raiz | lista os worktrees e a branch de cada um |
| `./scripts/dev-worktree.sh rm <branch>` | raiz | remove o worktree; só apaga a branch se ela já estiver mergeada na `main` |
| `git config core.hooksPath .githooks` | qualquer | ativa os hooks versionados — **necessário após cada clone novo** |

## Git: worktree por branch, `main` intocada

**Regra**: o worktree principal (`~/pdv-completo`) fica em `main` e serve só de
base/coordenação (ler, comparar, abrir o editor). **Todo desenvolvimento acontece
em worktree separado**, em `~/pdv-worktrees/<branch>` — um por branch, nunca
dentro do repo (o git recusa worktree dentro de outro repo).

```bash
./scripts/dev-worktree.sh new feat/minha-branch   # cria ~/pdv-worktrees/feat/minha-branch
git push -u origin feat/minha-branch && gh pr create --fill
./scripts/dev-worktree.sh rm feat/minha-branch    # apaga a branch só se já mergeada na main
```

**Nunca commit em `main`.** Fluxo de hotfix urgente é o mesmo: branch própria +
PR + squash merge. Não é mais rápido commitar na main — é o caminho que existe
para o urgente.

### Hooks locais (freio, não tranca)

`.githooks/pre-commit` e `.githooks/pre-push` barram commit e push direto na
`main`. São versionados, mas **não se auto-ativam**: após cada clone novo (ou
worktree novo em máquina nova), rode

```bash
git config core.hooksPath .githooks
```

O path é relativo ao topo da working tree, então vale para o worktree principal
e para todos os worktrees ligados. Dois detalhes: `pre-commit` **deixa passar
detached HEAD** (rebase, cherry-pick e merge aparecem assim — bloquear geraria
falso-positivo) e `pre-push` **nunca bloqueia `refs/tags/*`**, porque a tag é o
gatilho de deploy.

Os hooks são **freio de acidente**: `git commit --no-verify` /
`git push --no-verify` contornam. A barreira real é o ruleset da `main` no
GitHub, que recusa push direto mesmo com `--no-verify`. Para remover a proteção
do servidor:

```bash
gh api -X DELETE repos/OWNER/REPO/rulesets/ID
```

### Tag continua sendo o gate de deploy

O deploy **não** é disparado por push na `main`: `.github/workflows/deploy-on-tag.yml`
roda em `push: tags: v*.*.*`. Publicar versão é `./bump-version.sh <versão>`
+ `git push origin v<versão>`, e isso funciona de qualquer branch — é por isso
que `pre-push` deixa tag passar.

## Regras críticas

**Leia os guias detalhados antes de editar código:**
- Backend: `docs/agent-backend.md`
- Frontend: `docs/agent-frontend.md`
- Deploy: `docs/agent-deploy.md`
- Testes: `docs/agent-testing.md`

### Backend (resumo)

- **ESM + NodeNext**: imports com extensão `.js`
- **Camadas**: `domain` → `application` → `infra` → `http`
- **Transações assíncronas**: todo acesso dentro de `db.transaction` é `await tx...`
- **Migrations**: 5 arquivos, próximo é `0005_*`. Escrever idempotente. O boot falha se a migration falhar
- **Audit log + outbox na mesma transação** da escrita de domínio
- **Erros**: usar `AppError` com código do catálogo em `src/domain/errors.ts`
- **Idempotência**: endpoints marcados devem usar `withIdempotency` com `correlationId`
- **Lock otimista**: toda mutação de `order_item` exige `expectedVersion`
- **Estoque é ledger**: saldo = soma dos `quantity_delta` de `stock_movement`
- **Sem lint/typecheck configurado** — rode `npm run build` (tsc) para validar

### Frontend (resumo)

- **FSD**: `app → pages → widgets → features → entities → shared`
- **Sem lib de estado**: server-authoritative, mutation `await` + reload via REST
- **Realtime**: usar `useRealtime(token, rooms, onEvent, onReconnect)` — token como subprotocol
- **Mutations**: aguardar e recarregar; sem otimismo
- **Botão de ação fora do `<form>`**: vincular por `form="<idForm>"` + `noValidate`
- **UI em PT-BR**; ícones via `lucide-react`; estilos com Tailwind 4
- **Sobreposição tem dono**: `Modal`, `Drawer`, `ScreenHeader` ou `ConfirmModal` — nada de overlay ad-hoc
- **Menu principal = accordion** na esquerda (desktop) ou `Drawer` (mobile)
- **Login por PIN**: envio explícito (botão ou Enter), sem auto-envio em 6 dígitos
- Rodar `npm run lint` (oxlint) antes de terminar

### Git (resumo)

- **Nunca commitar na `main`**: branch própria + PR + squash merge, sempre via worktree (Trunk-Based com branches curtos).
- **Trunk-Based Development**: branches de vida curta (< 1–2 dias), PRs pequenos e frequentes. Integrar na `main` assim que aprovado e verde.
- **Conventional Commits obrigatório**: todos os commits devem seguir [Conventional Commits](https://www.conventionalcommits.org/). Validado automaticamente no PR (commitlint).
- **Versionamento automático**: no merge na `main`, Semantic Release analisa os commits, gera/atualiza `CHANGELOG.md`, cria **tag `vX.Y.Z`** e **GitHub Release** automaticamente (baseado no tipo de mudança: `feat`→minor, `fix/perf`→patch, `BREAKING CHANGE`→major).
- **Worktree por branch** em `~/pdv-worktrees/<branch>` (`./scripts/dev-worktree.sh new|list|rm`)
- **Hooks versionados** em `.githooks/`: precisam de `git config core.hooksPath .githooks` após clone novo
- Hook é **freio, não tranca** (`--no-verify` contorna); a garantia é o ruleset no GitHub
- **`rm` de worktree não apaga branch não mergeada** — publicar ou `branch -D` consciously
- **Tag é o gate de deploy**: produção é disparada **apenas** por push de tag `v*.*.*` (workflow `deploy-on-tag.yml`). Com o Semantic Release, a **tag deixa de ser manual e passa a ser automática e consistente**, sem alterar esse gate.
- **Deploy contínuo híbrido**: merge na `main` → valida em **staging** (healthcheck + smoke). Produção → só via **Release/Tag** automático (criado pelo Semantic Release).

### Deploy (resumo)

- **Healthcheck é o portão**: verde = schema aplicado. Verde doente → switch aborta antes do reload
- **Sem `lb_retries` no Caddy**: retentativa repetiria POST
- **`stream_close_delay 5m` em `/realtime*`**: não remover
- **Migrations expand/contract**: a versão antiga precisa continuar compatível com o schema novo

## Critérios de verificação gerais

Antes de dar qualquer mudança por feita:

1. Backend: `npm run build` (tsc) sem erros
2. Backend: `npm run test` (vitest) sem falhas — obrigatório quando o fluxo alterado tiver suíte
3. Frontend: `npm run lint`, `npm run build` e `npm run test` sem erros
4. Smoke manual por perfil: login → abrir comanda → lançar itens → (cozinha marca pronto) → garçom entrega → pagar → fechar
5. Conferir o critério de aceite correspondente em `docs/03-acceptance-criteria.md`
6. Toda mudança realtime: garantir que o evento chega a um room que o client realmente assina
7. Toda mudança de schema: novo arquivo `.sql` numerado em `backend/migrations/`
