# Mapa de Módulos do Backend

Mapa de use cases, rotas e testes para agentes encontrarem código rapidamente.

## Use Cases (Application Layer)

| Domínio | Use Case | Arquivo | Rotas Relacionadas |
|---|---|---|---|
| Auth | `login.usecase.ts` | `backend/src/application/auth/` | `auth.routes.ts` |
| Order | `order.usecases.ts` | `backend/src/application/order/` | `order.routes.ts` |
| Cash Flow | `cash-flow.usecases.ts` | `backend/src/application/cash-flow/` | `cash-flow.routes.ts` |
| Stock | `stock.usecases.ts` | `backend/src/application/stock/` | `stock.routes.ts` |
| Purchase | `purchase.usecases.ts` | `backend/src/application/purchase/` | `purchase.routes.ts` |
| Delivery | `calcular-entrega.usecase.ts` | `backend/src/application/delivery/` | `courier.routes.ts`, `delivery-manager.routes.ts` |
| Delivery | `delivery-pricing.usecase.ts` | `backend/src/application/delivery/` | `courier.routes.ts` |
| Delivery | `geocode-restaurant.usecase.ts` | `backend/src/application/delivery/` | `store-settings.routes.ts` (geocode) |
| Self-Service | `cart.usecases.ts` | `backend/src/application/self-service/` | `public.routes.ts` |
| Self-Service | `order-intake.usecase.ts` | `backend/src/application/self-service/` | `public.routes.ts` |
| Self-Service | `cancel-order.usecase.ts` | `backend/src/application/self-service/` | `public.routes.ts` |
| Self-Service | `customer-address.usecases.ts` | `backend/src/application/self-service/` | `customer-admin.routes.ts` |
| Self-Service | `menu.usecases.ts` | `backend/src/application/self-service/` | `public.routes.ts` |
| Alert | `alert.usecases.ts` | `backend/src/application/alert/` | `alert.routes.ts` |
| Audit | `audit-log.usecases.ts` | `backend/src/application/audit-log/` | `audit.routes.ts` |
| Report | `report.usecases.ts` | `backend/src/application/report/` | `report.routes.ts` |
| User | `user.usecases.ts` | `backend/src/application/user/` | `user.routes.ts` |
| Customer | `customer.usecases.ts` | `backend/src/application/customer/` | `customer.routes.ts` |
| Customer (CPF) | `cpf.ts` | `backend/src/domain/` | `customer.routes.ts` — valida DV, devolve os 11 dígitos crus |
| Product | `product.usecases.ts` | `backend/src/application/product/` | `catalog.routes.ts` |
| Category | `category.usecases.ts` | `backend/src/application/category/` | `catalog.routes.ts` |
| Kitchen Group | `kitchen-group.usecases.ts` | `backend/src/application/kitchen-group/` | `catalog.routes.ts` |
| Store Settings | `store-settings.usecases.ts` | `backend/src/application/store-settings/` | `store-settings.routes.ts` |
| Payment | `register-payment.usecase.ts` + `payment-lines.ts` | `backend/src/application/order/payment/` | `order.routes.ts` (`/orders/:id/payments*`) |
| Payment (port) | `payment-gateway.port.ts` | `backend/src/application/ports/` | interface do gateway — **sem implementação no checkout** (webhook = serviço Go `pagarme-webhook/`; docs 19/20 removidos em `308c9977`) |

## Rotas (HTTP Layer)

| Arquivo | Domínio | Endpoints |
|---|---|---|
| `auth.routes.ts` | Autenticação | `/auth/users`, `/auth/login` |
| `order.routes.ts` | Comandas | `/orders`, `/orders/:id`, `/orders/:id/items`, `/orders/:id/payments`, `/orders/:id/close`, `/tables` |
| `cash-flow.routes.ts` | Fluxo de Caixa | `/cash-drawer/*` |
| `courier.routes.ts` | Entregas (Entregador) | `/courier/deliveries/*` |
| `delivery-manager.routes.ts` | Entregas (Gerente) | `/manager/deliveries/*`, `/manager/couriers` |
| `alert.routes.ts` | Alertas | `/alerts`, `/alerts/mark-read` |
| `print.routes.ts` | Impressão | `/orders/:id/print`, `/printers/status`, `/printers/health` |
| `catalog.routes.ts` | Catálogo | `/products`, `/categories`, `/kitchen-groups` |
| `user.routes.ts` | Equipe | `/users`, `/users/:id/reset-pin`, foto de usuário |
| `customer.routes.ts` | Clientes | `/customers`, `/customers/search`, `/customers/:id/orders`, `/customers/:id/summary`, foto de cliente |
| `customer-admin.routes.ts` | Endereços de cliente | `/customers/:id/addresses*` |
| `report.routes.ts` | Relatórios | `/reports/sales`, `/reports/overview`, `/reports/deliveries` |
| `stock.routes.ts` | Estoque | `/stock`, `/stock/movements`, `/inventory/value` |
| `purchase.routes.ts` | Compras | `/suppliers`, `/purchases` |
| `audit.routes.ts` | Auditoria | `/audit-log` |
| `store-settings.routes.ts` | Configurações da loja | `/store-settings`, `/store/geocode-restaurant` |
| `public.routes.ts` | Público | `/public/menu`, `/public/orders`, `/public/orders/:id`, `/public/orders/:id/cancel`, `/public/orders/:id/status` |
| `realtime.routes.ts` | Realtime | `/realtime` (WebSocket) |
| `uploads.routes.ts` | Storage | `/uploads/:kind/:filename` |

> **Linhas removidas por não existirem no checkout**: `kitchen.routes.ts`,
> `ifood.routes.ts`, `payment.routes.ts` e `pagarme-webhook.routes.ts` — não há
> esses arquivos em `backend/src/http/routes/` nem registro no
> `router.plugin.ts`. Cobrança Pagar.me V5 = use cases em
> `application/order/payment/` + adapter via port `payment-gateway.port.ts`
> (sem implementação aqui); o webhook é o serviço Go `pagarme-webhook/`.

## Testes (Suítes)

| Arquivo | Cobertura |
|---|---|
| `test/alerts.test.ts` | Central de alertas (25 testes) |
| `test/cash-flow.test.ts` | Fluxo de caixa |
| `test/catalog.test.ts` | Catálogo |
| `test/delivery-location.test.ts` | Geocoding |
| `test/delivery-pricing.test.ts` | Preço de entrega |
| `test/idempotency.test.ts` | Idempotência |
| `test/maintenance.test.ts` | Outbox + cleanup |
| `test/order-flow.test.ts` | Comandas + eventos |
| `test/outbox-dispatcher.test.ts` | Dispatcher do outbox |
| `test/pagarme.test.ts` | Cobrança no Pagar.me V5 |
| `test/payment-lines.test.ts` | Linhas de pagamento da comanda |
| `test/pix-key.test.ts` | Chave Pix |
| `test/printer.test.ts` | Impressão |
| `test/profiles.test.ts` | Perfis |
| `test/purchase.test.ts` | Compras |
| `test/self-service.test.ts` | Página pública |
| `test/stock.test.ts` | Estoque |
| `test/team-customers.test.ts` | Clientes + equipe |
| `test/uploads.test.ts` | Storage por tenant |
| `test/architecture.test.ts` | **Ratchet de camadas** — application/http limpos; violação nova de import quebra o teste |
| `test/composition-compat.test.ts` | Nomes legados do composition root |
| `test/tenant-routing.test.ts` | Resolução de tenant por Host (`TENANT_ROUTING`) |
| `test/tenant-isolation.test.ts` | Isolamento por schema de tenant |

> `test/pagarme.test.ts` e `test/printer.test.ts` **não existem** (linhas
> removidas); a suíte tem também `tenant-cache`, `tenant-spike`, `refund`,
> `realtime-ws`, `courier-location`, `cash-flow-category`, `factories` e
> `caddy-on-demand-tls`.

## Infraestrutura

| Componente | Arquivo |
|---|---|
| DB Client | `backend/src/infra/db/client.ts` |
| Migrations (por schema) | `backend/src/infra/db/migrate.ts` |
| Migrations (registry/global em `public`) | `backend/src/infra/db/registry-migrate.ts` |
| Seed (catálogo + runners) | `backend/src/infra/db/seeds/` — `manifest.json` (catálogo, lido em runtime também pela CLI Rust), `registry.ts` (leitura validada por zod), `apply.ts` (runner genérico `seed:apply -- <id>`), `base.ts`, `demo.ts` (+ `demo/fixtures.ts`, `demo/plan.ts`), `prod.ts`. Os `backend/src/infra/db/seed*.ts` são wrappers finos |
| Load Menu | `backend/src/infra/db/load-menu.ts` |
| **Composition root (DI)** | `backend/src/infra/composition/default-usecases.ts` + re-export por domínio em `composition/domains/*.ts` — **único** lugar de wiring; rotas importam daqui |
| **Ports (application)** | `backend/src/application/ports/` — unit-of-work, tenant-context, effects, notifications, file-storage, payment-gateway, … |
| Unit-of-Work + ALS de tenant | `backend/src/infra/db/postgres-tenant-unit-of-work.ts`, `backend/src/infra/db/tenant-context.ts` |
| Outbox Dispatcher | `backend/src/infra/realtime/outbox-dispatcher.ts` |
| Maintenance | `backend/src/infra/maintenance.ts` |
| Advisory locks (dono único dos workers) | `backend/src/infra/locks.ts` |
| Cache | `backend/src/infra/cache/` (`redis-cache-client.ts`, `warmup.ts`, `index.ts` com `initCache`) |
| Mail (SMTP) | `backend/src/infra/mail/` (adapter do port `application/ports/notifications.port.ts`) |
| Plugins Fastify | `backend/src/http/plugins/router.plugin.ts` (registro de rotas), `tenant-context.plugin.ts` (resolução de tenant por Host) |

> **Cache layer atual:** `MemoryCache` singleton (fallback) → `RedisCacheClient` (via `ioredis`) quando `REDIS_URL` disponível. `initCache()` no `server.ts` testa conexão no boot; `warmup.ts` pré-popula por schema de tenant (`public.tenant` via registry). `tenantCache` particiona chaves por `${schema}:`. Veja `docs/01-backend-spec.md` §4.4 e `deploy/docker-compose.yml` (serviço `redis`).

## Integrações

| Integração | Arquivos |
|---|---|
| Google Maps | `backend/src/integrations/maps/` (5 arquivos) |
| Printer | `backend/src/integrations/printer/` (5 arquivos) |
| Pagar.me | webhook = serviço Go `pagarme-webhook/` (fora do backend); no backend só a port `application/ports/payment-gateway.port.ts` (sem adapter neste checkout) |

> **Linhas removidas por não existirem**: `backend/src/integrations/ifood/` e
> `backend/src/integrations/pagarme/` não estão nesta árvore (iFood fora do
> checkout; Pagar.me removido pela migration `0010_remove_payment_ifood.sql`).
> Os docs `18`/`19`/`20` também foram removidos em `308c9977`
> (`git show 308c9977^:docs/<arquivo>`).
