# Scripts de apoio

Índice único dos scripts do repositório. Cada domínio (deploy, printer) tem
seus próprios scripts e seus próprios detalhes — as seções abaixo apontam onde
procurar; este arquivo é o mapa, não o manual de cada um.

## Convenções

- Todo script começa com shebang (`#!/usr/bin/env bash`, ou `#!/bin/sh` quando
  é POSIX de propósito) e `set -euo pipefail` logo depois.
- Scripts bash de domínio compartilhado hoje sourceiam
  `source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"` (a partir de
  `scripts/`), que oferece `log`, `warn`, `die`, `require_cmd` e `load_env`.
  A lib não usa `set -e`: quem a sourceia decide o modo do shell.
- Nomes no padrão `verbo-substantivo.sh` (`build-standalone.sh`,
  `dev-worktree.sh`, `backup-fetch.sh`).
- `--help` imprime o uso e sai com código 0; argumento obrigatório ausente
  imprime o erro e sai com código != 0.
- Hooks de git vivem em `.githooks/` e só são ativados com
  `git config core.hooksPath .githooks` (ver AGENTS.md).

## Raiz

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `build-standalone.sh` | Build dos 4 apps standalone (Tauri) em um comando; resolve versão do `Cargo.toml`, prepara chave de assinatura local e cuida do CWD do build | `bash build-standalone.sh --app pdv [--release] [--bundles <tipo>]` | Node 20+, CLI do Tauri na raiz (`npm ci`), Rust/cargo |
| `bump-version.sh` | Bump de versão da família standalone: atualiza `Cargo.toml` (raiz) e `frontend/package.json` | `./bump-version.sh <nova-versão>` | — |

## `scripts/`

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `dev-worktree.sh` | Convenção de worktree por branch: `new`/`list`/`rm` de `~/pdv/<branch>` | `./scripts/dev-worktree.sh new <branch>` | git, `gh` (opcional, no `rm`) |
| `setup-dev.sh` | Sobe o ambiente de desenvolvimento: Node 20+, Docker/Postgres, `.env`, `npm install`, backend e frontend juntos | `bash scripts/setup-dev.sh` | Node 20+, Docker, npm |
| `lib/common.sh` | Biblioteca de helpers (`log`, `warn`, `die`, `require_cmd`, `load_env`); não executa nada sozinha | `source .../scripts/lib/common.sh` | bash |

## `deploy/`

Domínio próprio — o detalhe operacional mora em `deploy/README.md` e
`docs/agent-deploy.md`.

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `backup.sh` | Backup consistente do Postgres (pg_dump custom) + uploads, via container | `./deploy/backup.sh [destino]` | docker, container do Postgres no ar |
| `backup-fetch.sh` | Gera o backup no servidor via SSH e baixa o `.dump` localmente | `./deploy/backup-fetch.sh user@host` | ssh/scp, `sshpass` (se `PDV_SSH_PASS`) |
| `caddy-assemble.sh` | Monta a Caddyfile a partir do ponteiro de upstream e sobe/recarrega/valida | `caddy-assemble.sh run\|reload\|validate` | Caddy, ponteiro em `$PDV_UPSTREAM_STATE` |
| `install.sh` | Instalação do zero: containers, healthcheck, seed do gerente, cardápio | `./deploy/install.sh` | docker compose, `deploy/.env` |
| `probe-availability.sh` | Mede o downtime real durante um deploy (régua do "sem downtime") | `./deploy/probe-availability.sh --url <url> --seconds N` | curl |
| `reset.sh` | Reset total destrutivo: remove containers, imagens e volumes | `./deploy/reset.sh [--force]` | docker compose |
| `run-cloud.sh` | Exemplo de modo cloud local: exporta `DATABASE_URL` e sobe o Postgres | `./deploy/run-cloud.sh` | docker compose |
| `switch.sh` | Deploy azul/verde sem downtime: switch, `--status`, `--rollback`, `--install` | `./deploy/switch.sh [--rollback\|--status\|--install] [--no-build]` | docker compose, curl |

## `frontend/src-tauri/`

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `build-app.sh` | Build do app desktop v1 (Tauri): local, `--release` (exige chave), `--bundles`, `--appimage-docker` | `bash frontend/src-tauri/build-app.sh [--release] [--bundles <tipo>] [--appimage-docker]` | Node 20+, Rust, docker (só com `--appimage-docker`) |

## `printer/scripts/`

Domínio próprio — detalhes em `printer/README.md`.

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `install-linux.sh` | Compila e instala o daemon de impressão como serviço systemd | `sudo ./printer/scripts/install-linux.sh` | Go 1.22+, root, systemd |

## `.githooks/`

Ativados uma vez por clone com `git config core.hooksPath .githooks`.

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `pre-commit` | Freio local: barra commit direto na `main` | executado pelo git | sh |
| `pre-push` | Freio local: barra push/force-push na `main` do origin (tags passam) | executado pelo git | sh |
