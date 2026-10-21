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
./install.sh                     # default: ~/.local/bin
./install.sh --global            # /usr/local/bin (pode exigir sudo)
./install.sh --prefix /opt/pdv
./install.sh --uninstall
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
| `pdv setup [--no-seed]` | Executa `scripts/dev/setup-dev.sh`, que sobe o ambiente de dev **inteiro em containers** (docker compose: postgres, redis, backend, frontend e caddy), roda o seed e imprime as URLs |
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
| `seeds` | Lista os seeds do catálogo (lido **em runtime** do manifest do backend) |
| `seed <id>` | Aplica o seed `<id>` (`base`, `demo`, `prod`); sem id, só lista e imprime o uso |
| `seed-prod` | **Depreciado** — alias de `seed prod` (avisa e delega) |
| `deactivate-demo` | `npm run db:deactivate-demo` |
| `provision <slug> [nome]` | Roda `src/infra/db/provision-tenant.ts` via `npx tsx` |
| `reset-pin <slug> [pin]` | Roda `src/infra/db/reset-manager-pin.ts` via `npx tsx` |
| `add-user <slug> <nome> <perfil> [pin]` | Roda `src/infra/db/add-user.ts` via `npx tsx` |
| `list` | Lista os tenants do registry (mesma implementação da TUI; em single-tenant mostra o tenant implícito) |

`provision`/`reset-pin`/`add-user`/`list` carregam `backend/.env` com `dotenvy`
antes de chamar o `tsx`, e exportam `SLUG`/`DISPLAY_NAME`/`PIN`/`USER_*` no
ambiente. É a correção do bug da CLI Go, que passava `${DATABASE_URL}` literal
(a variável não era expandida).

### Tenant implícito (ambiente single-tenant)

Em single-tenant — o dev padrão: `TENANT_ROUTING=false` e
`DEFAULT_TENANT_SCHEMA` vazio — o app inteiro roda no schema `public`
(`resolveTenantSchemaInScope()` cai em `public`) e o registry `public.tenant`
fica **vazio**: só o provisionamento de tenant insere linha lá.

Sem tratamento, a lista de tenants vazia deixava a TUI sem alvo para os
fluxos que operam sobre um tenant — mesmo existindo um `store_settings` de
verdade (que vive em `public`, não em `tenant_<slug>`). Por isso:

- `pdv db list` e a tela "Listar tenants" mostram o **tenant implícito**
  (slug `default`, schema `public`, "Padrão (default)") quando o registry
  está vazio;
- `pdv db reset-pin default` e `pdv db add-user default …` resolvem para o
  schema default — o backend (`src/infra/db/default-tenant.ts`) cai no
  tenant implícito quando o slug reservado não está no registry;
- "Editar configurações", "Reset PIN" e "Backup/dump" passam a operar no
  store de dev.

O slug `default` é **reservado**: se um tenant real for provisionado com ele,
a linha do registry vence (a busca no registry vem antes do fallback).

### Catálogo de seeds

Os seeds do backend são um **catálogo em manifest**:
`backend/src/infra/db/seeds/manifest.json` (com o contrato em
`manifest.schema.json`). Cada seed declara `id`, `title`, `description`,
`npmScript`, `destructive`, `productionSafe` e `requiresPostgis`.

| id | npm script | o que faz |
|---|---|---|
| `base` | `seed:base` | `store_settings`, usuários de teste, categorias, produtos, mesas e saldo inicial de estoque |
| `demo` | `seed:demo` | seed base + catálogo demo, clientes e 30 dias de histórico (exige PostGIS) |
| `prod` | `seed:prod` | bootstrap de primeiro deploy: `store_settings` real + um manager com PIN temporário |

A CLI lê o manifest **em runtime**: adicionar um seed é mexer no manifest (e
no `package.json` do backend), **não** recompilar a CLI. O mesmo catálogo
move o backend (`npm run seed:apply -- <id>`) e a TUI.

`pdv db seed <id>` roda o `npm run <npmScript>` do backend:

- **no host**, quando `backend/node_modules` existe;
- **dentro do container do backend** (`docker exec`), quando o ambiente é
  100% containerizado — que é o padrão do `pdv setup` (o host só precisa do
  Docker). Dentro do container a CLI escolhe o comando pela imagem: na de
  **dev** (`src/` + `tsx`) roda `npm run <npmScript>`; na de **produção**
  (só `dist/`, sem `tsx`) roda `node dist/infra/db/seeds/apply.js <id>`.

Antes de um seed que exige PostGIS, a CLI roda um preflight
(`SELECT postgis_version()`) e aborta com mensagem explícita quando a
biblioteca não está na imagem do Postgres (a extensão pode estar *registrada*
no banco e ainda assim o `ST_*` falhar).

### Acesso ao banco sem `psql` no host

O ambiente de dev roda tudo em containers e o host **não tem** `psql`/
`pg_dump` instalados — chamá-los direto quebrava a TUI ("Listar tenants",
"Editar configurações", "Backup/dump do tenant") num host limpo. A camada
`ops/db.rs` resolve o alvo:

| Situação | Estratégia |
|---|---|
| `psql` no `PATH` | usa o binário do host |
| Sem `psql`, `DATABASE_URL` local (`localhost`/`127.0.0.1`) e container do Postgres rodando | `docker exec <container> psql …` |
| Sem `psql` e URL **remota** | erro: o fallback de container não vale para um banco remoto — instale `postgresql-client` |
| Sem `psql` e sem container | erro com as duas saídas (`pdv setup` ou `sudo apt install postgresql-client`) |

Dentro do container a URL é reescrita para `localhost:5432` (o banco é o
próprio container; a porta publicada no host pode ser outra) e o usuário, a
senha, o nome do banco e o `?sslmode=` são preservados. Quando há **mais de
um** container de Postgres do PDV na máquina, a escolha é desambiguada pela
porta publicada; se ainda assim for ambíguo, a CLI para e pede
`PDV_POSTGRES_CONTAINER=<container>`.

### De onde sai o `DATABASE_URL`

A URL do banco é resolvida nesta ordem:

1. variável `DATABASE_URL` do ambiente;
2. `backend/.env` (o arquivo gitignored do clone local);
3. **derivada do `deploy/.env.dev`** — o env que o `pdv setup` gera para o
   compose de dev (`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` +
   `DEV_POSTGRES_PORT`), com o host trocado para `localhost` (o compose usa o
   nome do serviço `postgres`, que só resolve dentro da rede do projeto).

O passo 3 é o que faz a CLI funcionar num host **só com Docker**: sem
`backend/.env` nem `psql` instalados, ela ainda acha o banco e ainda aplica
os seeds (o seed roda no host com essa URL exportada, ou dentro do container
do backend, que já tem a URL do compose).

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
| Listar tenants | Tabela de tenants (em single-tenant, o **tenant implícito**); `Enter` abre os **detalhes** |
| Adicionar novo tenant | Formulário (slug, nome) → confirmação → provisiona |
| Setup | Submenu: instalar dependências · configurar `.env` · rodar migrations · **aplicar seed de demonstração (demo)** · setup completo |
| Status dos serviços | Tabela de containers (painel inicial) |
| Aplicar seeds | Submenu com o **catálogo lido em runtime** (base · demo · prod); mostra descrição e flags do seed selecionado antes de aplicar, pede confirmação quando o seed é destrutivo e devolve a saída no painel de Output |
| Visualizar logs | Últimas linhas do backend (`docker compose logs`, fallback para arquivos locais) |
| Reset PIN do manager | Seletor de tenant → formulário (PIN opcional) → roda `reset-manager-pin.ts` |
| Editar configurações | Seletor de tenant → formulário de `store_settings` → `UPDATE` |
| Backup/dump do tenant | Seletor de tenant → confirmação → `pg_dump --schema` para `/tmp/tenant-<slug>-dump.sql` |

Em single-tenant, o único item da tabela é o tenant implícito (schema
`public`), e é ele que os fluxos de configuração/PIN/dump operam.

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
| `r` | Recarrega o painel atual (serviços, tenants, logs, catálogo de seeds) |
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
│   │                backend_logs / setup_full
│   ├── db.rs        acesso ao Postgres: psql/pg_dump no host OU via
│   │                `docker exec` no container (ambiente 100% containerizado)
│   ├── seeds.rs     catálogo de seeds lido do manifest do backend + aplicação
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

Referências antigas: `scripts/build/install-cli.sh` (go build) e
`scripts/dev/install-pdv-cli.sh` foram **removidos**; a instalação hoje é
só `install.sh` na raiz do repo.

## 7. Pendências conhecidas (fase 1)

- **Modo remoto** (admin-server / SSH) não implementado — previsto em
  [`25-admin-server-tui.md`](25-admin-server-tui.md). A TUI é somente local.
- **Suspender/reativar/remover tenant** não são ações da TUI nesta fase (o menu
  tem 9 itens fixos; essas operações ficam como evolução).
- **Testes**: a crate passou a ter testes unitários das partes puras
  (parsing do manifest de seeds e resolução da estratégia de acesso ao banco:
  host vs. container vs. URL remota).
- **Autocomplete de shell** (`pdv completion`) não portado.

Estas lacunas são intencionais nesta entrega; a evolução da TUI é a continuação
natural do plano em [`25-admin-server-tui.md`](25-admin-server-tui.md).
