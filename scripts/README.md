# Scripts e ferramentas de desenvolvimento

Índice único dos scripts do repositório. Cada domínio (deploy, build, dev) tem
seus próprios scripts e seus próprios detalhes — as seções abaixo apontam onde
procurar; este arquivo é o mapa, não o manual de cada um.

## Localizar scripts

`./pdv` (raiz do repo) é o dispatcher único: diagnóstico, dev, build, test,
lint, banco, check pré-PR e os scripts de apoio de deploy/build. Sem
argumentos (ou com `--help`) imprime a ajuda completa e sai com 0.

```bash
./pdv status                          # diagnóstico read-only do ambiente
./pdv setup                           # setup do ambiente de dev
./pdv worktree <new|list|rm>          # convenção de worktree por branch
./pdv dev <backend|frontend|all>      # npm run dev; frontend aceita --profile <pdv|kds|garcon|entregador>
./pdv build <standalone|app|backend|frontend>          # Tauri / tsc / vite
./pdv test <backend|frontend|gateway|all>      # vitest e go test
./pdv lint <frontend|all>             # oxlint; `all` soma o gate de gofmt do ws-gateway
./pdv db <migrate|migrate-registry|generate|seed|seed-prod|deactivate-demo>
./pdv check [backend|frontend|all]    # critérios de verificação gerais (portão pré-PR)
./pdv release bump <versão>           # bump da família standalone
./pdv deploy <switch|backup|backup-fetch|probe|install|reset|caddy|run-cloud|pedido> [opções]
```

Os subcomandos que mapeiam um script fazem `exec bash <script>` com os
argumentos crus — os caminhos diretos das tabelas abaixo continuam válidos.
Os que não têm script próprio (`status`, `dev`, `build backend|frontend`,
`test`, `lint`, `db`, `check`) rodam npm/go com cwd explícito: ver
"Comandos wrapper (npm/go)" abaixo.

## Comandos wrapper (npm/go)

A CLI **não moveu nem renomeou nenhum script**: estes comandos só rodam
`npm run`/`go` no diretório certo, com os MESMOS nomes de script do
`package.json`. `cd backend && npm run db:migrate`, `cd frontend && npm run lint`
ou `cd ws-gateway && go test ./...` continuam equivalentes.

| Comando `./pdv` | O que roda |
|---|---|
| `status` | git (branch + status curto), `dev-worktree.sh list`, versões de git/node/npm/go/docker e presença de `backend/node_modules`, `frontend/node_modules` e `backend/.env` — só leitura, nada altera estado |
| `dev backend` | `npm run dev` em `backend/` (`tsx watch`) |
| `dev frontend [--profile <pdv\|kds\|garcon\|entregador>]` | `npm run dev`, ou `dev:<perfil>` (o `cross-env` do frontend) |
| `dev all` | backend em segundo plano + frontend em foreground; Ctrl+C (ou a morte do frontend) derruba o backend junto |
| `build backend` / `build frontend` | `npm run build` (tsc → `dist/` / vite → build de produção) |
| `test backend` / `test frontend` | `npm run test` (vitest) |
| `test gateway` | os mesmos três comandos em `ws-gateway/` |
| `test all` | backend, frontend e gateway — nessa ordem |
| `lint frontend` | `npm run lint` (oxlint) em `frontend/` |
| `lint all` | oxlint + gate de `gofmt -l .` em `ws-gateway/` (o mesmo `test -z` do CI: imprime os arquivos e falha) |
| `check [backend\|frontend\|all]` | os "critérios de verificação gerais" do AGENTS.md: backend = build (tsc) + test; frontend = lint + build + test; all = os dois. Default: `all` |

Para deployment, use [`../deploy/README.md`](../deploy/README.md). Para validar testes/builds, consulte [`../docs/agent-testing.md`](../docs/agent-testing.md) e os comandos dos `package.json` do componente. Não use instruções antigas que mencionem um executável `./pdv` na raiz ou diretórios de serviço que não existam no checkout.

## Desenvolvimento manual

- Backend: `cd ../backend && npm ci`; consulte `../docs/agent-backend.md` para banco, ambiente e testes.
- Frontend: `cd ../frontend && npm ci`; `npm run dev`, `npm run lint`, `npm run test` e `npm run build` conforme a tarefa.
- Apps Rust/Tauri: use o workspace Cargo da raiz e os README de cada crate. Build exige toolchain Rust/Tauri e pode ter requisitos específicos de assinatura.
- CLI: `cd ../cmd/pdv && go test ./...`; instalação via `build/install-cli.sh` depende da configuração descrita no próprio script.

- Todo script começa com shebang (`#!/usr/bin/env bash`, ou `#!/bin/sh` quando
  é POSIX de propósito) e `set -euo pipefail` logo depois.
- Scripts bash de domínio compartilhado sourceiam a lib em
  `scripts/lib/common.sh` (`source "$ROOT/scripts/lib/common.sh"`), que
  oferece `log`, `warn`, `die`, `require_cmd` e `load_env`. A lib não usa
  `set -e`: quem a sourceia decide o modo do shell.
- Nomes no padrão `verbo-substantivo.sh` (`build-standalone.sh`,
  `dev-worktree.sh`, `backup-fetch.sh`).
- `--help` imprime o uso e sai com código 0; argumento obrigatório ausente
  imprime o erro e sai com código != 0.
- Hooks de git vivem em `.githooks/` e só são ativados com
  `git config core.hooksPath .githooks` (ver AGENTS.md).

## `scripts/dev/`

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `setup-dev.sh` | Sobe o ambiente de desenvolvimento: Node 20+, Docker/Postgres, `.env`, `npm install`, backend e frontend juntos | `./pdv setup` ou `bash scripts/dev/setup-dev.sh` | Node 20+, Docker, npm |
| `dev-worktree.sh` | Convenção de worktree por branch: `new`/`list`/`rm` de `~/pdv/<branch>` | `./pdv worktree list` ou `bash scripts/dev/dev-worktree.sh list` | git, `gh` (opcional, no `rm`) |

## `scripts/build/`

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `build-standalone.sh` | Build dos 4 apps standalone (Tauri) em um comando; resolve versão do `Cargo.toml`, prepara chave de assinatura local e cuida do CWD do build | `./pdv build standalone --app pdv [--release]` | Node 20+, CLI do Tauri na raiz (`npm ci`), Rust/cargo |
| `build-app.sh` | Build do app desktop v1 (Tauri): local, `--release` (exige chave), `--bundles`, `--appimage-docker` | `./pdv build app [--release]` ou `bash scripts/build/build-app.sh` | Node 20+, Rust, docker (só com `--appimage-docker`) |

## `scripts/release/`

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `bump-version.sh` | Bump de versão da família standalone: atualiza `Cargo.toml` (raiz) e `frontend/package.json` | `./pdv release bump <nova-versão>` | — |

## `scripts/lib/`

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `common.sh` | Biblioteca de helpers (`log`, `warn`, `die`, `require_cmd`, `load_env`); não executa nada sozinha | `source "$ROOT/scripts/lib/common.sh"` | bash |
| `build-tauri.sh` | Biblioteca de lógica de build Tauri compartilhada (`tauri_require_node`, `tauri_resolve_signing`, `tauri_parse_bundles`, `tauri_list_artifacts`, `tauri_final_message`); requer `common.sh` já sourceado | `source "$ROOT/scripts/lib/build-tauri.sh"` (de `scripts/build/`) | bash 4.3+ (nameref) |

## `deploy/`

Domínio próprio — o detalhe operacional mora em `deploy/README.md` e
`docs/agent-deploy.md`.

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `backup.sh` | Backup consistente do Postgres (pg_dump custom) + uploads, via container | `./pdv deploy backup [destino]` ou `./deploy/backup.sh [destino]` | docker, container do Postgres no ar |
| `backup-fetch.sh` | Gera o backup no servidor via SSH e baixa o `.dump` localmente | `./pdv deploy backup-fetch user@host` ou `./deploy/backup-fetch.sh user@host` | ssh/scp, `sshpass` (se `PDV_SSH_PASS`) |
| `caddy-assemble.sh` | Monta a Caddyfile a partir do ponteiro de upstream e sobe/recarrega/valida | `./pdv deploy caddy run\|reload\|validate` ou `caddy-assemble.sh run\|reload\|validate` | Caddy, ponteiro em `$PDV_UPSTREAM_STATE` |
| `deploy-pedido-public.sh` | Republica SÓ o app público de pedidos (`apps/pedido-public`), sem rodízio azul/verde do PDV | `./pdv deploy pedido` ou `./deploy/deploy-pedido-public.sh` | docker compose, `deploy/.env` |
| `install.sh` | Instalação do zero: containers, healthcheck, seed do gerente, cardápio | `./pdv deploy install` ou `./deploy/install.sh` | docker compose, `deploy/.env` |
| `probe-availability.sh` | Mede o downtime real durante um deploy (régua do "sem downtime") | `./pdv deploy probe --url <url> --seconds N` ou `./deploy/probe-availability.sh --url <url> --seconds N` | curl |
| `reset.sh` | Reset total destrutivo: remove containers, imagens e volumes | `./pdv deploy reset [--force]` ou `./deploy/reset.sh [--force]` | docker compose |
| `run-cloud.sh` | Exemplo de modo cloud local: exporta `DATABASE_URL` e sobe o Postgres | `./pdv deploy run-cloud` ou `./deploy/run-cloud.sh` | docker compose |
| `switch.sh` | Deploy azul/verde sem downtime: switch, `--status`, `--rollback`, `--install` | `./pdv deploy switch [--rollback\|--status\|--install] [--no-build]` ou `./deploy/switch.sh …` | docker compose, curl |

## `.githooks/`

Ativados uma vez por clone com `git config core.hooksPath .githooks`.

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `pre-commit` | Freio local: barra commit direto na `main` | executado pelo git | sh |
| `pre-push` | Freio local: barra push/force-push na `main` do origin (tags passam) | executado pelo git | sh |
