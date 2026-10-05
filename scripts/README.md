# Scripts de apoio

Índice único dos scripts do repositório. Cada domínio (deploy, printer) tem
seus próprios scripts e seus próprios detalhes — as seções abaixo apontam onde
procurar; este arquivo é o mapa, não o manual de cada um.

## Porta de entrada

`./pdv` (raiz do repo) é o dispatcher único para os scripts de apoio:

```bash
./pdv setup                        # setup do ambiente de dev
./pdv worktree <new|list|rm>       # convenção de worktree por branch
./pdv build standalone [opções]    # build dos apps standalone (Tauri)
./pdv build app [opções]           # build do app desktop v1 (Tauri)
./pdv release bump <versão>        # bump de versão da família standalone
./pdv deploy <switch|backup|probe|install> [opções]
./pdv printer install              # daemon de impressão (Linux)
```

Cada comando faz `exec` do script correspondente — os caminhos diretos abaixo
continuam válidos.

## Convenções

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
| `backup.sh` | Backup consistente do Postgres (pg_dump custom) + uploads, via container | `./deploy/backup.sh [destino]` | docker, container do Postgres no ar |
| `backup-fetch.sh` | Gera o backup no servidor via SSH e baixa o `.dump` localmente | `./deploy/backup-fetch.sh user@host` | ssh/scp, `sshpass` (se `PDV_SSH_PASS`) |
| `caddy-assemble.sh` | Monta a Caddyfile a partir do ponteiro de upstream e sobe/recarrega/valida | `caddy-assemble.sh run\|reload\|validate` | Caddy, ponteiro em `$PDV_UPSTREAM_STATE` |
| `install.sh` | Instalação do zero: containers, healthcheck, seed do gerente, cardápio | `./deploy/install.sh` | docker compose, `deploy/.env` |
| `probe-availability.sh` | Mede o downtime real durante um deploy (régua do "sem downtime") | `./deploy/probe-availability.sh --url <url> --seconds N` | curl |
| `reset.sh` | Reset total destrutivo: remove containers, imagens e volumes | `./deploy/reset.sh [--force]` | docker compose |
| `run-cloud.sh` | Exemplo de modo cloud local: exporta `DATABASE_URL` e sobe o Postgres | `./deploy/run-cloud.sh` | docker compose |
| `switch.sh` | Deploy azul/verde sem downtime: switch, `--status`, `--rollback`, `--install` | `./deploy/switch.sh [--rollback\|--status\|--install] [--no-build]` | docker compose, curl |

## `printer/scripts/`

Domínio próprio — detalhes em `printer/README.md`.

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `install-linux.sh` | Compila e instala o daemon de impressão como serviço systemd | `sudo ./printer/scripts/install-linux.sh` ou `./pdv printer install` | Go 1.22+, root, systemd |

## `.githooks/`

Ativados uma vez por clone com `git config core.hooksPath .githooks`.

| Caminho | O que faz | Como invocar | Dependências |
|---|---|---|---|
| `pre-commit` | Freio local: barra commit direto na `main` | executado pelo git | sh |
| `pre-push` | Freio local: barra push/force-push na `main` do origin (tags passam) | executado pelo git | sh |
