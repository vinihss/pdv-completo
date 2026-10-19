# 27 — CLI `pdv` (Rust)

> **Status: implementado (fase 1).** Documenta a CLI local em `cmd/pdv/`,
> reescrita em Rust no lugar da antiga CLI Go. A TUI já abre todas as telas do
> menu (listar/adicionar/editar tenants, logs, seeds, reset de PIN e backup); o
> modo remoto (servidor/SSH) **não** faz parte desta fase — o plano segue em
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
| `add-user <slug> <nome> <perfil> [pin]` | Roda `src/infra/db/add-user.ts` via `npx tsx` |
| `list` | Roda `src/infra/db/list-tenants.ts` via `npx tsx` |

`provision`/`reset-pin`/`add-user`/`list` carregam `backend/.env` com `dotenvy`
antes de chamar o `tsx`, e exportam `SLUG`/`DISPLAY_NAME`/`PIN`/`USER_*` no
ambiente. É a correção do bug da CLI Go, que passava `${DATABASE_URL}` literal
(a variável não era expandida).

## 4. TUI (`pdv tui`)

```bash
pdv tui
```

Exige **terminal interativo** (TTY real). Rodada sem TTY, apenas imprime
`TUI só funciona em terminal interativo` e sai.

**Layout master-detail**: menu de navegação fixo à esquerda (30%) e painel de
conteúdo à direita (70%), com bordas arredondadas e a descrição do item
selecionado no rodapé do menu.

**Painel inicial = "Status dos Serviços"**, carregado automaticamente ao abrir.
Tabela `Container | Status | Saúde | Portas` a partir de `docker ps`:

| Campo | Cores |
|---|---|
| `Status` (state) | `running` → verde · `restarting` → amarelo · `exited`/`paused`/`dead` → vermelho · outros → cinza |
| `Saúde` (health) | `healthy` → verde · `unhealthy` → vermelho · `starting` → amarelo · `n/a` → cinza |

Tudo na TUI opera **localmente**: consulta `public.tenant` e
`tenant_<slug>.store_settings` via `psql` (usando o `DATABASE_URL` de
`backend/.env`) e delega provisionamento/reset/usuário para os scripts `tsx` do
backend.

**Itens do menu e telas**

| Item | Tela |
|---|---|
| Listar tenants | Tabela de tenants; `Enter` abre os **detalhes** |
| Adicionar novo tenant | Formulário (slug, nome) → confirmação → provisiona |
| Setup | Submenu: instalar dependências · configurar `.env` · rodar migrations · aplicar seeds · setup completo |
| Status dos serviços | Tabela de containers (painel inicial) |
| Aplicar seeds | Submenu: seed de desenvolvimento · seed de produção |
| Visualizar logs | Últimas linhas do backend (`docker compose logs`, fallback para arquivos locais) |
| Reset PIN do manager | Seletor de tenant → formulário (PIN opcional) → roda `reset-manager-pin.ts` |
| Editar configurações | Seletor de tenant → formulário de `store_settings` → `UPDATE` |
| Backup/dump do tenant | Seletor de tenant → confirmação → `pg_dump --schema` para `/tmp/tenant-<slug>-dump.sql` |

**Detalhes do tenant** (atingido por "Listar tenants" → `Enter`) expõem os
atalhos `s` (editar configurações), `d` (backup/dump) e `u` (adicionar usuário).
Não há `r` de reset nessa tela (o reset é item próprio do menu).

> **Correção em relação à CLI Go:** a edição de configurações no modo local
> nunca funcionou porque o Go lia/escrevia uma coluna JSONB `settings` que não
> existe. `store_settings` é uma tabela de **colunas fixas** (singleton
> `id = 'singleton'`); a TUI Rust lê e grava as colunas reais
> (`merchant_name`, `merchant_city`, `printer_enabled`, `printer_auto_print`,
> `uses_delivery`, `whatsapp_integration_enabled`).
>
> O atalho `u` (adicionar usuário) agora tem script próprio:
> `backend/src/infra/db/add-user.ts` (também exposto como `pdv db add-user`).

**Teclas**

| Tecla | Ação |
|---|---|
| `↑` / `k` | Sobe na lista |
| `↓` / `j` | Desce na lista |
| `g` / `G` | Primeiro / último item |
| `Enter` | Abre o item do menu / seleciona / confirma |
| `Esc` | Volta um nível (telas → "Status dos Serviços") |
| `r` | Recarrega o painel atual (serviços, tenants, logs) |
| `q` | Sai (exceto dentro de formulários, onde `q` é digitável) |
| `s` / `d` / `u` | Atalhos na tela de detalhes do tenant |
| `Tab` / `↑↓` | Alterna campos em formulários |

## 5. Arquitetura

```
cmd/pdv/src/
├── main.rs          parse do clap → dispatch
├── cli/mod.rs       enum de subcomandos + handlers (delegação)
├── config/mod.rs    resolução da raiz do repo (cwd / PDV_ROOT)
├── runner/mod.rs    helpers: exec_script, npm_run, run_cmd_in_dir,
│                    capture_cmd_in_dir, capture_npm_run
├── ops/
│   ├── mod.rs       list_tenants / get|update store_settings / dump_tenant /
│   │                create_tenant / reset_manager_pin / add_user /
│   │                backend_logs / setup_full (psql, pg_dump, npx tsx)
│   └── services.rs  list_services (docker ps --format json)
├── tui/
│   ├── mod.rs       loop, layout 30/70, execução dos jobs fora do draw
│   ├── model.rs     estado do App, telas, formulários, jobs e teclas
│   ├── components.rs renderização (menu, tabelas, formulários, logs, saída)
│   └── styles.rs    paleta harmônica + ícones Unicode
└── ui/mod.rs        helpers de saída/erro
```

Jobs bloqueantes (consultas `psql`, `npm`, `npx`, `pg_dump`, `docker`) rodam
**fora do `draw`**: o loop desenha um frame com `⏳ <mensagem>`, executa o job e
aplica o resultado (painel de saída ou atualização do estado). Não há threads.

O status dos serviços usa `docker ps --format json` (campo `Names`, sem barra
inicial nesta versão) e ordena por nome. Sem Docker disponível, a lista fica
vazia (o painel mostra "Nenhum container encontrado").

## 6. Diferenças em relação à CLI Go

A CLI Go (`cobra` + `bubbletea`) foi **removida** de `cmd/pdv/` — não há
coexistência. Não foram portados:

| Comando Go | Situação |
|---|---|
| `connect` / `servers` | Removidos — modo remoto é fase futura (plano em [`25-admin-server-tui.md`](25-admin-server-tui.md)) |
| `tenant` | Removido (as operações de tenant hoje vivem em `pdv db` + TUI) |
| `release bump` | Removido — o versionamento é automático pelo Semantic Release (ver [`agent-deploy.md`](agent-deploy.md)) |
| `completion` | Não portado (autocomplete de shell) |

Referências antigas: `scripts/build/install-cli.sh` (go build) foi **removido**;
a instalação hoje é só `scripts/dev/install-pdv-cli.sh`.

## 7. Pendências conhecidas (fase 1)

- **Modo remoto** (admin-server / SSH) não implementado — previsto em
  [`25-admin-server-tui.md`](25-admin-server-tui.md). A TUI é somente local.
- **Suspender/reativar/remover tenant** não são ações da TUI nesta fase (o menu
  tem 9 itens fixos; essas operações ficam como evolução).
- **Testes** não portados nesta fase (`cargo test` roda sem testes).
- **Autocomplete de shell** (`pdv completion`) não portado.

Estas lacunas são intencionais nesta entrega; a evolução da TUI é a continuação
natural do plano em [`25-admin-server-tui.md`](25-admin-server-tui.md).
