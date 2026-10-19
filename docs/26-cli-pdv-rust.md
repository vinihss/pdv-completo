# 26 — CLI `pdv` (Rust)

> **Status: implementado (fase 1).** Documenta a CLI local em `cmd/pdv/`,
> reescrita em Rust no lugar da antiga CLI Go. O modo remoto (servidor/SSH)
> **não** faz parte desta fase — o plano segue em
> [`25-admin-server-tui.md`](25-admin-server-tui.md).
>
> **Data:** 2026-10-18 · Fonte de verdade: `cmd/pdv/src/` e `pdv --help`.

---

## 1. O que é

`pdv` é a CLI de desenvolvimento e administração local do repositório. Ela:

- opera **direto sobre a pasta local do repo** (não exige servidor remoto);
- localiza a raiz pelo diretório atual, com a env `PDV_ROOT` como override
  (`cmd/pdv/src/config/mod.rs`);
- delega para os scripts do repo (`scripts/`, `deploy/`) e para os `npm run`
  do backend/frontend — não reimplementa lógica de negócio.

É um **crate Rust independente** (`cmd/pdv/Cargo.toml` tem um `[workspace]`
vazio de propósito) e está no `exclude` do workspace Cargo da raiz; por isso
não é compilado junto com os crates Tauri/standalone.

| | |
|---|---|
| Binário | `pdv` |
| Crate | `pdv-cli` (`cmd/pdv`) |
| Edição | Rust 2021 |
| Deps principais | `clap`, `ratatui`, `crossterm`, `dotenvy`, `which`, `anyhow` |

## 2. Instalação

```bash
# a partir da raiz do repo
bash scripts/dev/install-pdv-cli.sh            # default: ~/.local/bin
bash scripts/dev/install-pdv-cli.sh --global   # /usr/local/bin (pode exigir sudo)
bash scripts/dev/install-pdv-cli.sh --prefix /opt/pdv
bash scripts/dev/install-pdv-cli.sh --uninstall
```

O script roda `cargo build --release` dentro de `cmd/pdv/` e copia o binário
para `$PREFIX/bin/pdv`. **O default é `~/.local/bin`, não `/usr/local/bin`** —
instalação no sistema é opt-in via `--global`.

Build manual, sem instalar:

```bash
cd cmd/pdv
cargo build --release      # binário em target/release/pdv
cargo test                 # hoje sem testes portados (ver §7)
```

Requer toolchain Rust (`cargo`). `cargo fmt`/`clippy` não são portões deste
componente.

## 3. Comandos

Sem argumentos, `pdv` imprime a ajuda e sai com `0`. Cada domínio valida o
próprio argumento e sai com código `!= 0` em uso inválido.

| Domínio | O que faz |
|---|---|
| `pdv status` | Bloco git, worktrees, versões de ferramentas e presença de dependências locais |
| `pdv tui` | Interface interativa (ver §4) |
| `pdv setup [--no-seed]` | Executa `scripts/dev/setup-dev.sh` |
| `pdv dev <backend\|frontend\|all> [--profile <pdv\|kds\|garcon\|entregador>]` | Sobe `npm run dev` no alvo; `--profile` só é válido em `frontend`/`all` |
| `pdv build <standalone\|app\|backend\|frontend> [opções]` | `standalone`/`app` → `scripts/build/build-app.sh`; os demais → `npm run build` |
| `pdv test [backend\|frontend\|gateway\|all]` | Backend/frontend via npm; `gateway` via `scripts/test/test-gateway.sh`. Default `all` |
| `pdv lint [frontend\|all]` | Frontend via oxlint; `all` também roda o gate de `gofmt` do `ws-gateway` |
| `pdv check [backend\|frontend\|all]` | Sequência de validação: backend `build`+`test`; frontend `lint`+`build`+`test` |
| `pdv worktree <new\|list\|rm> ...` | Encapsula `scripts/dev/dev-worktree.sh` |
| `pdv deploy <sub> ...` | Encapsula os scripts de `deploy/` (`switch`, `backup`, `backup-fetch`, `probe`, `install`, `reset`, `caddy`, `run-cloud`, `pedido`) |
| `pdv db <sub> ...` | Ver tabela abaixo |

### `pdv db`

| Sub | O que faz |
|---|---|
| `migrate` | `npm run db:migrate` no backend |
| `migrate-registry` | `npm run db:migrate:registry` |
| `generate` | `npm run db:generate` |
| `seed` | `npm run seed` |
| `seed-prod` | `npm run seed:prod` |
| `deactivate-demo` | `npm run db:deactivate-demo` |
| `provision <slug> [nome]` | Roda `src/infra/db/provision-tenant.ts` via `npx tsx` |
| `reset-pin <slug> [pin]` | Roda `src/infra/db/reset-manager-pin.ts` via `npx tsx` |
| `list` | `npm run db:list` |

`provision`/`reset-pin` carregam `backend/.env` com `dotenvy` antes de chamar o
`tsx`, e exportam `SLUG`/`DISPLAY_NAME`/`PIN` no ambiente. É a correção do bug
da CLI Go, que passava `${DATABASE_URL}` literal (a variável não era expandida).

## 4. TUI (`pdv tui`)

```bash
pdv tui
```

Exige **terminal interativo** (TTY real). Rodada sem TTY, apenas imprime
`TUI só funciona em terminal interativo` e sai.

**Layout master-detail**: menu de navegação fixo à esquerda (30%) e painel de
conteúdo à direita (70%), ambos com borda.

**Painel inicial = "Status dos Serviços"**, carregado automaticamente ao abrir.
Tabela `Container | Status | Saúde | Portas` a partir de `docker ps`:

| Campo | Cores |
|---|---|
| `Status` (state) | `running` → verde · `restarting` → amarelo · `exited`/`paused`/`dead` → vermelho · outros → cinza |
| `Saúde` (health) | `healthy` → verde · `unhealthy` → vermelho · `starting` → amarelo · `n/a` → cinza |

**Teclas**

| Tecla | Ação |
|---|---|
| `↑` / `k` | Sobe no menu |
| `↓` / `j` | Desce no menu |
| `g` / `G` | Primeiro / último item |
| `r` | Recarrega o painel de serviços |
| `Enter` | **placeholder** — ainda não aciona o item selecionado |
| `q` / `Esc` | Sai |

**Itens do menu** (navegáveis, ainda sem ação — ver §7): Listar tenants,
Adicionar novo tenant, Setup, Status dos serviços, Aplicar seeds, Visualizar
logs, Reset PIN do manager, Editar configurações, Backup/dump do tenant.

> **Estado atual:** a TUI é a "casca" funcional (menu + painel de status). As
> telas de listar/editar tenants, logs, seeds, reset de PIN e backup existem
> como itens de menu, mas `Enter` não abre nada ainda. A listagem de tenants
> já existe como função (`ops::list_tenants`, via `psql`) mas **não** está
> ligada à TUI.

## 5. Arquitetura

```
cmd/pdv/src/
├── main.rs          parse do clap → dispatch
├── cli/mod.rs       enum de subcomandos + handlers (delegação)
├── config/mod.rs    resolução da raiz do repo (cwd / PDV_ROOT)
├── runner/mod.rs    helpers: exec_script, npm_run, run_cmd_in_dir
├── ops/
│   ├── mod.rs       list_tenants (psql) e tipos
│   └── services.rs  list_services (docker ps --format json)
├── tui/
│   ├── mod.rs       loop, layout 30/70, tabela de status, teclas
│   ├── model.rs     estado do App: seleção, itens de menu, serviços
│   ├── components.rs (vazio hoje)
│   └── styles.rs    cores semânticas
└── ui/mod.rs        helpers de saída/erro
```

O status dos serviços usa `docker ps --format json` (campo `Names`, sem barra
inicial nesta versão) e ordena por nome. Sem Docker disponível, a lista fica
vazia (o painel mostra "Nenhum container encontrado").

## 6. Diferenças em relação à CLI Go

A CLI Go (`cobra` + `bubbletea`) foi **removida** de `cmd/pdv/` — não há
coexistência. Não foram portados:

| Comando Go | Situação |
|---|---|
| `connect` / `servers` | Removidos — modo remoto é fase futura (plano em [`25-admin-server-tui.md`](25-admin-server-tui.md)) |
| `tenant` | Removido (as operações de tenant hoje vivem em `pdv db` + TUI, ainda incompleta) |
| `release bump` | Removido — o versionamento é automático pelo Semantic Release (ver [`agent-deploy.md`](agent-deploy.md)) |
| `completion` | Não portado (autocomplete de shell) |

Referências antigas: `scripts/build/install-cli.sh` (go build) foi **removido**;
a instalação hoje é só `scripts/dev/install-pdv-cli.sh`.

## 7. Pendências conhecidas (fase 1)

- **Ações do menu da TUI** — `Enter` não abre telas; itens são placeholders.
- **Telas de tenant** (listar/adicionar/editar/backup/logs/seeds/reset de PIN)
  ligadas ao menu.
- **`ops::list_tenants`** existe mas não é consumida pela UI.
- **Testes da TUI** não foram portados nesta fase (`cargo test` roda sem
  testes). Testes de unidade dos módulos também estão por vir.
- **Autocomplete de shell** (`pdv completion`) não portado.

Estas lacunas são intencionais nesta entrega (reescrita + paridade de CLI);
a evolução da TUI é a continuação natural do plano em
[`25-admin-server-tui.md`](25-admin-server-tui.md).
