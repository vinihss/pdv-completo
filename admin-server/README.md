# admin-server

Serviço HTTP em Go que roda **no host da aplicação** e deixa uma TUI remota
administrar o PDV: tenants (criar, renomear, suspender), `store_settings`,
cache do Redis e backups. É a **Fase 1** de
[`docs/25-admin-server-tui.md`](../docs/25-admin-server-tui.md).

Módulo Go próprio (`pdv-admin-server`), no mesmo padrão do `ws-gateway/`. Sem
framework: `net/http` + `http.ServeMux` com padrões method+wildcard (Go 1.22+).

## Configuração (env)

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `PDV_ADMIN_TOKEN` | sim | — | Token bearer esperado em `Authorization`. Sem ele o boot falha. |
| `PDV_DATABASE_URL` | sim | — | DSN do Postgres (registry `public.tenant` + schemas de tenant). |
| `PDV_ADMIN_ADDR` | não | `127.0.0.1:9090` | Endereço de bind. |
| `PDV_REDIS_URL` | não | `redis://127.0.0.1:6379` | Redis usado por `POST /admin/cache/clear`. |
| `PDV_BACKEND_CONTAINER` | não | `deploy-backend-1` | Container onde o provisioning roda via `docker exec`. |
| `PDV_DEPLOY_DIR` | não | vazio | Diretório com `backup.sh`. Vazio faz `/admin/backup` responder 503. |
| `PDV_ADMIN_RATE_PER_MIN` | não | `120` | Teto de requisições por minuto, por IP. |
| `GIT_SHA` | não | `dev` | Versão reportada no `/health`. |

`GET /health` é a única rota sem autenticação (liveness). Tudo em `/admin/...`
exige `Authorization: Bearer <PDV_ADMIN_TOKEN>` e está sujeito ao rate limit.

## Endpoints

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | `/health` | — | `{"status":"ok","version":"…","uptimeSeconds":N}` |
| GET | `/admin/tenants` | — | `{"tenants":[Tenant,…]}` |
| POST | `/admin/tenants` | `{"slug","display_name"}` | `201 {"tenant":Tenant,"manager_pin":"1234"}` |
| PATCH | `/admin/tenants/{slug}` | `{"display_name"}` | `{"tenant":Tenant}` |
| PATCH | `/admin/tenants/{slug}/status` | `{"status":"active"\|"suspended"}` | `{"tenant":Tenant}` |
| GET | `/admin/tenants/{slug}/settings` | — | `{"settings":StoreSettings}` |
| PUT | `/admin/tenants/{slug}/settings` | objeto parcial | `{"settings":StoreSettings}` |
| POST | `/admin/cache/clear` | — | `{"flushed":true}` |
| POST | `/admin/backup` | `{"target":"db"\|"files"\|"all"}` (default `all`) | `{"target":"…","paths":["/abs/…"]}` |

`Tenant` = `{"slug","schema_name","display_name","status","custom_domain","created_at"}`.

Erros são sempre `{"error":{"code":<string>,"message":<string>}}`. Códigos:
`unauthorized`, `rate_limited`, `invalid_body`, `invalid_slug`, `invalid_status`,
`invalid_target`, `unknown_field`, `invalid_type`, `invalid_value`, `not_found`,
`not_configured`, `provision_failed`, `backup_failed`, `internal`.

### `POST /admin/tenants`

Roda, no host:

```
docker exec <PDV_BACKEND_CONTAINER> node dist/infra/db/provision-tenant.js <slug> <display_name>
```

com timeout de 5 min. O PIN do manager é extraído do stdout
(`PIN:\s*(\S+)`) e devolvido **uma única vez**. **Nunca é logado nem
persistido** — se não for encontrado, o tenant é criado do mesmo jeito e
`manager_pin` volta vazio. Falha do script → 500 `provision_failed` com a saída
combinada (truncada em 2000 caracteres).

### `PUT /admin/tenants/{slug}/settings`

Aceita só as colunas de `store_settings` (tabela de colunas fixas). Chave fora
da whitelist → 400 `unknown_field`; o valor nunca é interpolado como
identificador SQL. Enum `pix_key_type` validado em `cpf|cnpj|email|phone|random`.
`enabled_payment_methods` e `delivery_fee_tiers` aceitam a string JSON ou o
array/objeto nativo (serializado para texto).

## Divergências documentadas

1. **`public.tenant` não tem coluna `id`.** O identificador do registry é o
   `slug` (chave primária). O `Tenant` da API reflete isso — não invente um `id`.
2. **`backup.sh` sempre produz os dois artefatos** (`.dump` do banco e
   `-uploads.tar.gz` das fotos). O `target` (`db`/`files`/`all`) só filtra o que
   é **reportado** na resposta; ele não evita o trabalho do outro artefato.

## Segurança e exposição

O bind padrão é `127.0.0.1:9090`: só a própria máquina alcança. O token é
estático e, em HTTP puro, viaja em claro. **Para expor além do localhost, ponha
o serviço atrás do Caddy com TLS** — sem HTTPS o bearer é capturável por
qualquer um no caminho. O serviço não tenta gerenciar TLS.

## Desenvolvimento

```bash
cd admin-server
gofmt -l .        # não deve imprimir nada
go vet ./...
go test ./...
go build ./...
```

Os testes usam fakes para `TenantStore`, `SettingsStore`, `Provisioner`,
`CacheFlusher` e `BackupRunner` (via `httptest`), então não precisam de
Postgres nem Redis.
