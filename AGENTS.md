# AGENTS.md — PDV Restaurante/Pub

Guia para agentes e desenvolvedores. Consulte [`docs/README.md`](docs/README.md) para navegar por tarefa e identificar documentos vigentes.

## Protocolo de trabalho para agentes

1. Identifique a tarefa, os arquivos envolvidos e o guia canônico da área antes de editar.
2. Para comportamento atual e comandos, confira código, testes, `package.json`, scripts e CI; não confie em contagens ou versões copiadas sem verificação.
3. Specs descrevem intenção de produto; planos e documentos históricos não provam que algo está implementado. Se um conflito puder mudar comportamento, dados ou segurança, explicite-o e não escolha silenciosamente.
4. Respeite o escopo/permissões do agente. Mudanças transversais (contratos, migrations, deploy, áreas compartilhadas) exigem revisar consumidores e coordenar os domínios afetados.
5. Antes de concluir, execute as validações pertinentes, revise o diff e relate arquivos alterados, comandos/resultados, testes não executados e riscos.
6. A documentação deste repositório não autoriza acesso a produção. Para operações de banco, siga [`docs/agent-db-maintenance.md`](docs/agent-db-maintenance.md); se ambiente ou autorização estiverem incertos, pare e esclareça.

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
standalone-pdv/  App Caixa (Tauri): tem o renderizador ESC/POS em Rust
            (`src/printing/`), que imprime direto no spooler/socket TCP. É o
            único renderizador neste repositório — o daemon Go de impressão
            saiu daqui para reescrita à parte. Detalhes em
            `docs/agente-hardware-printing.md`.
ws-gateway/ Gateway WebSocket em Go (módulo Go independente):
            mesmo handshake, mesmas rooms e mesmo outbox do backend Node, para
            substituir o `backend/src/infra/realtime/`. Plugado no `deploy/`
            (Caddy + os três compose) atrás da flag `WS_BACKEND=go` (default
            `node`) e de `profiles: ["ws-gateway"]`, e com o gate de posse
            `WS_DISPATCH` (desligado por padrão) decidindo se o dispatcher
            publica: subir o stack **não** liga o gateway — o realtime vivo
            continua sendo o Node (ver `docs/agent-deploy.md`)
```

> **Apps mobile não estão mais neste repositório.** O codebase `mobile/`
> (Garçom/Entregador, React Native + Expo SDK 57) foi para o projeto separado
> **`pdv-mobile-apps`** (`~/Downloads/pdv-mobile-apps`), que também recebeu
> `docs/22-mobile-react-native.md` e o agente `.opencode/agents/mobile-expert.md`.
> Aqui ficam o backend e os contratos REST/realtime que os apps consomem, os docs
> de domínio (`docs/21`, `docs/05`). Os crates Tauri dos apps Garçom/Entregador
> foram **removidos** deste repo (não há mais apps Tauri para Garçom/Entregador aqui).

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
| `docs/17-runbook-unificacao-migrations.md` | Runbook do cutover para o baseline único de migrations (com validação de backup) |
| `docs/18-ifood-por-loja.md` | iFood por tenant: estado atual, delta necessário, riscos (sem implementação) |
| `docs/19-pagarme.md` | Camada de pagamentos Pagar.me V5: arquitetura, webhook, reconciliação, decisões e pendências |
| `docs/20-pagarme-pendencias.md` | Pendências da integração Pagar.me V5: o que falta, risco e prioridade |
| `docs/21-device-provisioning.md` | Device provisioning (aparelhos vinculados ao tenant/usuário) — implementação Tauri (apenas PDV/KDS). Os apps Garçom/Entregador usam RN e vivem no repo `pdv-mobile-apps`. |
| `ws-gateway/GO-GATEWAY-PLAN.md` | Gateway WebSocket em Go: arquitetura, rooms, outbox, fases de migração e o checklist de implantação. Mora junto do código (fora de `docs/`) porque é spec de um componente, não do produto inteiro |

### Guias para agentes

| Arquivo | Conteúdo |
|---|---|
| `docs/agent-backend.md` | Convenções backend: camadas, transações, migrations, estoque, alertas, impressão |
| `docs/agent-frontend.md` | Convenções frontend: FSD, camadas, componentes, overlays, menu, Tauri |
| `docs/agent-deploy.md` | Deploy azul/verde: switch, healthcheck, regras, backup, os dois portões que falhavam em silêncio (título da PR = mensagem do squash; tag publicada sem deploy) |
| `docs/agent-testing.md` | Como descobrir e rodar os testes de backend, frontend, gateway WS, Pagar.me e impressão |
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

### Apps mobile (React Native/Expo) — repo separado

Os apps mobile **saíram deste repositório** e vivem no projeto próprio
**`pdv-mobile-apps`** (`~/Downloads/pdv-mobile-apps`): um único codebase Expo
SDK 57 gera os dois apps via `APP_VARIANT=garcon|entregador` (ids
`com.pdvapp.garcon` / `com.pdvapp.entregador`, iguais aos antigos crates Tauri).
Provisionamento usa `expo-camera`/`expo-local-authentication`/`expo-secure-store`;
realtime segue o mesmo contrato (WebSocket com token em subprotocol).

Para mexer no app, trabalhe naquele repo — comandos e guia em
`pdv-mobile-apps/README.md` e `pdv-mobile-apps/mobile/README.md`; contexto e
pendências em `pdv-mobile-apps/docs/22-mobile-react-native.md` (o doc 22 veio
junto com o codebase). Aqui só o que é compartilhado: contrato REST/realtime do
backend e `docs/21-device-provisioning.md`. Mudança de contrato exige
coordenação entre os dois repositórios.

### App desktop (Tauri)

O app v1 (`frontend/src-tauri/`, `com.pdvapp.desktop`, em produção) está
**desacoplado do frontend**: `frontend/` é só a aplicação web (e o bundle que os
apps standalone servem). Os scripts `desktop:*` saíram do `frontend/package.json`
(as deps de runtime `@tauri-apps/*` seguem lá) e a CLI `@tauri-apps/cli` mora
agora na **raiz do repo** (`node_modules/.bin/tauri`, `package.json` da raiz).

```bash
# a partir da raiz
bash scripts/build/build-app.sh            # build local (instalador; sem sidecar — daemon de impressão fora do repo)
bash scripts/build/build-app.sh --release  # build de entrega: exige chave de assinatura
(cd frontend && ../node_modules/.bin/tauri dev)  # roda o app no desktop
```

O script resolve os caminhos pela própria localização, então também vale
`bash scripts/build/build-app.sh` a partir da raiz do repo. Não existe mais
`npm run desktop:build` / `npm run desktop:dev`.

## Perfis de acesso

O mesmo código cobre 5 perfis, cada um com sua superfície no login e seus papéis no JWT (`backend/src/http/middlewares/auth.middleware.ts`): `waiter`, `kitchen`, `manager`, `cashier` e `courier`.

### App desktop (Tauri)

Duas armadilhas que já custaram tempo (detalhe em `docs/11-desktop-instalador.md` §8.1-8.2):

- **AppImage não empacota no Arch** — o `strip` do `linuxdeploy` não conhece a seção `.relr.dyn` das libs do Arch e o build morre with "failed to run linuxdeploy". The `.deb` sai normal; para o AppImage use `bash scripts/build/build-app.sh --appimage-docker` (empacota num `debian:bookworm-slim`).
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
| `./pdv <comando>` | raiz | dispatcher único dos scripts de apoio (`./pdv --help`) |
| `npm run dev` | backend | roda com `tsx watch` |
| `npm run build` | backend | `tsc` → `dist/` |
| `npm run start` | backend | roda `dist/http/server.js` |
| `npm run seed` | backend | seed de dev (usuários/PINs fictícios) |
| `npm run seed:prod` | backend | seed de primeiro deploy (sem dados fictícios) |
| `npm run db:migrate` | backend | aplica `migrations/*.sql` (também roda no boot em modo local) |
| `npm run db:migrate:registry` | backend | aplica `migrations/registry/*.sql` no schema `public` (registry de tenant; roda no boot antes do `db:migrate`) |
| `npm run db:provision -- <slug> "<nome>"` | backend | provisiona um tenant novo: cria o schema `tenant_<slug>`, aplica as migrations dentro dele, registra em `public.tenant` e roda o bootstrap (`store_settings` + manager com PIN no log). `SEED=0` pula o bootstrap |
| `./pdv db provision <slug> "<nome>"` | raiz | mesmo provisionamento pelo dispatcher (é o caminho curto do `db:provision`) |
| `npm run test` | backend | Vitest (`backend/test/*.test.ts`; confira `TEST_DATABASE_URL` e o setup atual) |
| `npm run lint` | frontend | oxlint |
| `npm run build` | frontend | build de produção (Vite) |
| `npm run test` | frontend | Vitest (jsdom + Testing Library; veja a saída do comando para a contagem atual) |
| `bash scripts/build/build-app.sh` | frontend | build do app desktop v1 (Tauri); `--release` = entrega (chave de assinatura), `--appimage-docker` = AppImage |
| `node_modules/.bin/tauri <cmd>` | raiz | CLI do Tauri (na raiz do repo, não em `frontend/node_modules`; rodar com cwd=`frontend/` para o app v1) |
| `bash scripts/build/install-cli.sh` | raiz | compila o CLI Go (`cmd/pdv`) e instala o binário `pdv` em `$PREFIX/bin` (default `/usr/local/bin`); `--uninstall` remove |
| `go build ./...` / `go vet ./...` / `go test ./...` | `ws-gateway` | portão do gateway WS: build, vet e suíte (é o que o CI roda, junto com `gofmt -l .`) |
| `./switch.sh` | deploy | deploy sem downtime (instância nova + `caddy reload`); `--status`, `--rollback`, `--install`, `--no-build`. Não mexe no `ws-gateway` |
| `docker compose --profile ws-gateway up -d --build ws-gateway` | deploy | sobe **só** o gateway WS em Go — o `up` normal não o cria (está atrás de `profiles`) |
| `./probe-availability.sh --url <url> --seconds N` | deploy | mede o gap de downtime real (sai != 0 se houve falha) |
| `./scripts/dev/dev-worktree.sh new <branch>` | raiz | cria o worktree de trabalho em `~/pdv/<branch>` (dentro do clone bare), a partir da `origin/main` já atualizada |
| `./scripts/dev/dev-worktree.sh list` | raiz | lista os worktrees e a branch de cada um |
| `./scripts/dev/dev-worktree.sh rm <branch>` | raiz | remove o worktree; só apaga a branch se ela já estiver mergeada na `main` |
| `git config core.hooksPath .githooks` | qualquer | ativa os hooks versionados — **necessário após cada clone novo** |

## Git: worktree por branch, `main` intocada

**Regra**: o repositório é um **clone bare** em `~/pdv/.bare`. Cada branch de trabalho
tem seu próprio worktree **dentro de `~/pdv/<branch>`** — um por branch, nunca dentro de
outro worktree (o git recusa). O worktree de `main` fica em `~/pdv/main` e serve só de
base/coordenação (ler, comparar, abrir o editor). **Todo desenvolvimento acontece em
worktree separado**; o clone bare em `~/pdv/.bare` não tem working tree.

```bash
./scripts/dev/dev-worktree.sh new feat/minha-branch   # cria ~/pdv/feat/minha-branch
git push -u origin feat/minha-branch && gh pr create --fill
./scripts/dev/dev-worktree.sh rm feat/minha-branch    # apaga a branch só se já mergeada na main
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
roda em `push: tags: v*.*.*` (backend) e `app-v*.*.*` (app). O versionamento é
automático via Semantic Release no merge da `main` — a tag nasce sozinha.
`scripts/release/bump-version.sh` é fallback de emergência (deprecated), não o caminho normal —
é por isso que o `pre-push` deixa tag passar.

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
- **Migrations**: baseline único `backend/migrations/0001_init.sql` (cadeia antiga arquivada em `backend/migrations/archive/`). Novas migrations incrementais vão como `0002_*`, `0003_*`, … — sempre idempotentes. O boot falha se a migration falhar
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
- **Auto-merge habilitado**: o repo tem `allow_auto_merge: true`. Após abrir a PR com `gh pr create --fill`, ativar o merge automático de squash com `gh pr merge --auto --squash` — o GitHub faz o merge sozinho assim que CI (backend, frontend, commitlint) ficar verde. Não é mais necessário clicar em "Merge" à mão. **Observação (gh 2.101.0)**: o subcomando `--auto` retornou sucesso sem registrar (`autoMergeRequest: null`); workaround que funcionou na PR #65: `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "'$(gh pr view <n> --json id --jq .id)'", mergeMethod: SQUASH}) { pullRequest { autoMergeRequest { enabledAt } } } }'`. Se nada persistir, `gh pr checks <n> --watch` + `gh pr merge <n> --squash` manual.
- **Trunk-Based Development**: branches de vida curta (< 1–2 dias), PRs pequenos e frequentes. Integrar na `main` assim que aprovado e verde.
- **Conventional Commits obrigatório**: todos os commits devem seguir [Conventional Commits](https://www.conventionalcommits.org/). Validado automaticamente no PR (commitlint).
- **O título da PR também tem que ser Conventional Commit**, porque o merge é squash e **o GitHub usa o TÍTULO da PR como mensagem do commit**. O commitlint valida os commits da branch, nunca o título — por isso o job `Validar título da PR (Conventional Commit)` existe no `pr-checks.yml`. Medido no PR #89: título `feat/printer` entrou com 31 arquivos e 5.586 linhas, o run do release ficou verde e **nenhuma tag saiu**. Atenção: a config de squash deste repo é `COMMIT_OR_PR_TITLE`, então com **um** commit só quem vira commit é a mensagem do commit; com **2+**, é o título. E editar o título **depois** de enfileirar o auto-merge não muda o commit — cancele o auto-merge, renomeie, reenfileire. Detalhes em `docs/agent-deploy.md` § "Os dois portões que falhavam em silêncio".
- **O `!` de breaking no título não publica major**: o preset `conventionalcommits` não lê o `!` no cabeçalho, a linha sai com `type=null` e o `commit-analyzer` devolve `release=undefined`. Major sai com a nota `BREAKING CHANGE:` no **corpo** do commit. O job avisa sobre isso.
- **Versionamento automático**: no merge na `main`, Semantic Release analisa os commits, gera/atualiza `CHANGELOG.md`, cria **tag `vX.Y.Z`** e **GitHub Release** automaticamente (baseado no tipo de mudança: `feat`→minor, `fix/perf`→patch, `BREAKING CHANGE`→major).
- **Worktree por branch** dentro do clone bare (`~/pdv/<branch>`; `./scripts/dev/dev-worktree.sh new|list|rm`)
- **Hooks versionados** em `.githooks/`: precisam de `git config core.hooksPath .githooks` após clone novo
- Hook é **freio, não tranca** (`--no-verify` contorna); a garantia é o ruleset no GitHub
- **`rm` de worktree não apaga branch não mergeada** — publicar ou `branch -D` consciously
- **Tag é o gate de deploy**: produção é disparada **apenas** por push de tag `v*.*.*` (backend) ou `app-v*.*.*` (app) (workflow `deploy-on-tag.yml`). A tag é criada automaticamente pelo Semantic Release no merge da `main`.
- **Fluxo real**: merge na `main` → CI de PR (`ci-pr.yml`/`tests.yml`) valida; produção → só via tag automática do Semantic Release (`deploy-on-tag.yml`).
- **A tag do Semantic Release só acorda o deploy se o `release.yml` usar o PAT** (`SEMANTIC_RELEASE_TOKEN`, escopo `contents: write`): o GitHub não dispara workflows a partir de eventos criados com `GITHUB_TOKEN`. Sem o secret, o `release.yml` cai no fallback e publica a tag do mesmo jeito — **o versionamento continua, o deploy não sai**. Detalhe em `deploy/README.md` § Quem cria a tag.
- **ESTADO ATUAL (05/10/2026): o PAT ainda NÃO foi criado** — `gh secret list` não mostra `SEMANTIC_RELEASE_TOKEN`. Consequência medida: `v1.25.0`/`v1.25.1`/`v1.25.2` publicaram tag sem nenhum run de deploy (produção parada ~20h) e `v1.26.0`/`v1.26.1` idem. É um secret, então **não dá para criar de dentro de uma PR** — quem cria é o dono do repositório (`gh secret set SEMANTIC_RELEASE_TOKEN --repo <owner>/<repo>`, PAT fine-grained, escopo `contents: write`, só neste repo). O `||` fallback do `release.yml` é **intencional**: sem o PAT o versionamento continua funcionando e só o deploy não dispara; virar string vazia pura quebraria o versionamento inteiro por causa de um secret inexistente.
- **Dois workflows vigiam a travessia inteira**: `pr-checks.yml` valida o título da PR (que é a mensagem do squash) e `auditoria-deploy.yml` roda diário perguntando se a tag mais recente chegou em produção. As regras e as armadilhas estão em `docs/agent-deploy.md` § "Os dois portões que falhavam em silêncio".

### Deploy (resumo)

- **Healthcheck é o portão**: verde = schema aplicado. Verde doente → switch aborta antes do reload
- **Sem `lb_retries` no Caddy**: retentativa repetiria POST
- **`stream_close_delay 5m` em `/realtime*`**: não remover
- **Migrations expand/contract**: a versão antiga precisa continuar compatível com o schema novo
- **Realtime tem duas implementações**: quem serve `/realtime*` é `PDV_WS_UPSTREAM`, resolvido por `deploy/caddy-assemble.sh` na ordem *ponteiro* > `WS_BACKEND` > *acompanhar `PDV_BACKEND_UPSTREAM`*. `caddy validate` **não** resolve upstream, então nome de serviço errado passa; o `ws-gateway` fica atrás de `profiles` e fora do rodízio azul/verde. Quem garante que só o dono do `/realtime` publica é o gate `WS_DISPATCH` (default-deny, dentro do processo — o `profiles` sozinho **não** fecha a janela de subir o container antes do Caddy virar), e o `./switch.sh --status` mostra o estado do gate cruzando-o com o upstream (detalhes em `docs/agent-deploy.md`)

## Critérios de verificação gerais

Antes de dar qualquer mudança por feita:

1. Backend: `npm run build` (tsc) sem erros
2. Backend: `npm run test` (vitest) sem falhas — obrigatório quando o fluxo alterado tiver suíte
3. Frontend: `npm run lint`, `npm run build` e `npm run test` sem erros
4. Smoke manual por perfil: login → abrir comanda → lançar itens → (cozinha marca pronto) → garçom entrega → pagar → fechar
5. Conferir o critério de aceite correspondente em `docs/03-acceptance-criteria.md`
6. Toda mudança realtime: garantir que o evento chega a um room que o client realmente assina
7. Toda mudança de schema: novo arquivo `.sql` numerado em `backend/migrations/`
8. Impressão (renderizador Rust; o daemon Go saiu deste repo — reescrita à parte):
   - app Rust: `cargo test -p pdv-caixa` na raiz, e **`rust_imprime_o_mesmo_que_o_go`
     tem que passar** — é o golden byte a byte do cupom. Ele NÃO pega erro na
     conversão de code page (o golden compara o render lógico, em UTF-8), então
     uma mudança em `codepage.rs` precisa de teste próprio de bytes, não só o green
   - `cargo fmt` em arquivo que você não mexeu reformata código de outra pessoa:
     formate só o seu (`rustfmt --edition 2021 <arquivo>`)
