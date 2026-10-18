# 25 — Admin server (Go) + TUI remota de administração

> **Status: PLANO — nada neste documento foi implementado.**
> Escopo: controlar o PDV (tenants, configurações, manutenção, backup) a
> partir de um servidor remoto (nuvem ou local) via CLI/TUI.
> **Data:** 2026-10-11 · **Autor:** dono do produto + agente (a partir da
> exploração de `cmd/pdv/`, `backend/` e `deploy/`)

---

## 1. Estado atual (verificado no código)

- **`cmd/pdv/`** (Go + cobra + bubbletea): a TUI é **só local**. O pacote
  `internal/ops` dispara `psql`, `pg_dump` e `npx tsx` contra o clone local
  do repo (`config.RootPath`). `~/.pdv/servers.json` já tem campos SSH
  (`user`, `key_path`) mas **SSH nunca foi implementado** — é só um comentário
  em `ops.go`.
- **Backend (Node/Fastify): não existe API de administração.** Operações de
  tenant são script (`npm run db:provision`) ou SQL direto. Os roles são
  `waiter/kitchen/manager/courier/cashier` — não há role admin, e o JWT é
  **escopo de tenant** (não serve para operar o registry `public.tenant`).
  `provisionTenantSchema(slug, displayName)` já é função exportada e
  reutilizável em-processo (`backend/src/infra/db/provision-tenant.ts`).
- **Infra no host:** Redis (`backend/src/infra/cache/`), `deploy/switch.sh`
  (deploy azul/verde), `deploy/backup.sh` (`pg_dump -Fc` + tar do volume de
  uploads), `deploy/backup-fetch.sh`. Compose nomeia os containers
  `deploy-backend-1`, `deploy-postgres-1`, `deploy-redis-1`.
- **`store_settings` é tabela de colunas fixas** (não JSONB):
  `merchant_name`, `merchant_city`, `brand_color`, `pix_key`, toggles
  (`uses_tables`, `kitchen_enabled`, `uses_delivery`, …) — ver
  `backend/migrations/0001_init.sql:724`.
- O antigo `docs/15` §10.7 deixava em aberto: "painel de administração entra neste
  projeto ou é manual (script)? O plano assume manual." Este documento é a
  resposta: **entra, como serviço Go separado no host**. (`docs/15-multi-tenant-schema.md`
  foi removido em `308c9977`; `git show 308c9977^:docs/15-multi-tenant-schema.md`)

## 2. Decisões tomadas (dono do produto, 2026-10-11)

| Pergunta | Decisão |
|---|---|
| Onde roda o admin backend | **Novo serviço Go no host** da aplicação (local ou remoto); a TUI se comunica com ele |
| Autenticação | **Token estático** (`PDV_ADMIN_TOKEN` no servidor, salvo no cliente) |
| Deploy | **SSH do TUI** (usa `user`/`key_path` já previstos em `servers.json`) |
| Backup | **Roda no servidor**; a TUI mostra os caminhos (`backup-fetch.sh` já existe para trazer) |

## 3. Arquitetura

```
┌─────────────┐   HTTPS/Bearer    ┌──────────────────┐   pgx    ┌──────────┐
│  pdv TUI    │ ────────────────▶ │  admin-server    │ ───────▶ │ Postgres │
│ (cmd/pdv)   │                   │  (Go, no host)   │ ───────▶ │  Redis   │
└──────┬──────┘                   └────────┬─────────┘          └──────────┘
       │ SSH (switch.sh)                   │ docker exec
       ▼                                   ▼
   host: deploy/switch.sh        deploy-backend-1 (provision)
```

### 3.1 `admin-server/` (novo, módulo Go próprio — padrão do repo, como `ws-gateway/`)

Config por env: `PDV_ADMIN_TOKEN` (obrigatório), `PDV_DATABASE_URL`,
`PDV_REDIS_URL`, `PDV_BACKEND_CONTAINER` (default `deploy-backend-1`),
`PDV_DEPLOY_DIR`. Bind `127.0.0.1:9090` por padrão (porta configurável).

| Endpoint | O que faz |
|---|---|
| `GET /health` | Viveza — a TUI valida ao conectar |
| `GET /admin/tenants` | Lista `public.tenant` (id, slug, display_name, status, created_at) via pgx |
| `POST /admin/tenants` | `{slug, display_name}` → `docker exec <backend> node dist/infra/db/provision-tenant.js` (provisioning provado: migrations + seed + manager). O PIN do manager sai no stdout do script — capturar e devolver na resposta (**exibir uma vez, nunca persistir**) |
| `PATCH /admin/tenants/:slug` | Renomear (`UPDATE public.tenant SET display_name`) |
| `PATCH /admin/tenants/:slug/status` | `active` ↔ `suspended` |
| `GET /admin/tenants/:slug/settings` | Lê `tenant_<slug>.store_settings` (tipado) |
| `PUT /admin/tenants/:slug/settings` | UPDATE parcial; **colunas em whitelist** (anti-injeção) |
| `POST /admin/cache/clear` | FLUSHDB do Redis (go-redis) |
| `POST /admin/backup` | `{target: db\|files\|all}` → roda `deploy/backup.sh` → devolve caminhos |

Auth: `Authorization: Bearer <PDV_ADMIN_TOKEN>` + rate limit.

### 3.2 `cmd/pdv` — cliente remoto

- `internal/remote`: HTTP client (base URL + token) e tipos dos contratos.
- `pdv connect <nome> <url> <token>`: valida `GET /health` e salva em
  `~/.pdv/servers.json` com **chmod 0600** (hoje o arquivo é 0644 —
  consertar ao introduzir token), acrescentando campos `url` + `token`.
- `pdv servers list|remove`.

### 3.3 TUI

- `ScreenConnect` (primeira tela sem conexão): form nome/URL/token.
- Header mostra o servidor conectado.
- Menu reorganizado:
  - **Tenants**: listar · criar (formulário + confirmação) · editar ·
    habilitar/desabilitar · configurações
  - **Manutenção**: limpar cache
  - **Backup**: banco · arquivos
- Detail do tenant: `e` editar · `s` settings · `x` habilitar/desabilitar ·
  `b` backup.
- Modo local atual mantido quando não houver servidor conectado.

### 3.4 Deploy (SSH do TUI)

`internal/ssh` (`golang.org/x/crypto/ssh`) usando `user`/`key_path` do
`servers.json`: roda `bash <PDV_DEPLOY_DIR>/deploy/switch.sh` no host com
**stream da saída em tempo real** na TUI. O switch tem downtime curto por
design (azul/verde) — a TUI exige confirmação explícita antes de disparar.

## 4. Fases

1. **admin-server** (Go): health, auth, tenants CRUD + status, settings,
   cache, backup + testes.
2. **CLI**: `connect` + cliente remoto + storage 0600.
3. **TUI**: telas remotas (connect, tenants, formulários).
4. **TUI**: manutenção (cache, backup) + deploy SSH.

As fases são independentes: a Fase 1 pode começar e ser entregue sozinha.

## 5. Riscos e abertos

- **Provisioning via `docker exec`** acopla ao nome do container — mitigado
  com `PDV_BACKEND_CONTAINER` (mesmo padrão de `PDV_PG_CONTAINER` no
  `backup.sh`).
- **Token estático em claro:** na nuvem, o admin-server deve ficar atrás do
  Caddy com TLS; sem HTTPS o token viaja em claro. Decidir a
  exposição (porta interna vs. Caddy) na Fase 1.
- **PIN do manager** só aparece no stdout do provision — capturar e mostrar
  uma vez, nunca persistir (nem em log de auditoria).
- **Dependência pendente:** a reavaliação do modelo (schema único + `tenant_id`
  + RLS) — antes `docs/23-reavaliacao-multi-tenant.md`, removido em `308c9977`
  (`git show 308c9977^:docs/23-reavaliacao-multi-tenant.md`) — **foi decidida**:
  ver `docs/26-identidade-centralizada.md` (§9, workstream B). O admin-server
  fala com o registry `public.tenant`; se o modelo mudar, as queries da
  Fase 1 precisam de revisão — mas o contrato HTTP fica.
- **`switch.sh`** precisa de acesso ao docker do host — o SSH do TUI é o
  caminho (decisão §2); o admin-server **não** tenta disparar deploy.
- Backups ficam no servidor; política de retenção/Off-site continua manual
  (ver `deploy/backup.sh` §cron).

## 6. Referências

- `cmd/pdv/internal/ops/ops.go` — operações locais atuais (padrão a
  estender/migrar para `internal/remote`)
- `cmd/pdv/internal/config/servers.go` — `servers.json` (adicionar `url`/`token`)
- `backend/src/infra/db/provision-tenant.ts` — provisioning reutilizado
- `backend/migrations/0001_init.sql:724` — `store_settings` (colunas)
- `deploy/backup.sh`, `deploy/switch.sh` — scripts de manutenção
- `docs/15-multi-tenant-schema.md` §6 — provisionamento; §10.7 — esta
  pendência (removido em `308c9977`; `git show 308c9977^:docs/15-multi-tenant-schema.md`)
- `docs/23-reavaliacao-multi-tenant.md` — decisão que afeta o registry
  (removido em `308c9977`; a decisão vigente está em `docs/26-identidade-centralizada.md`)
