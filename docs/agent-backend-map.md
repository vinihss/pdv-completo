# Mapa de Módulos do Backend

Mapa de use cases, rotas e testes para agentes encontrarem código rapidamente.

## Use Cases (Application Layer)

| Domínio | Use Case | Arquivo | Rotas Relacionadas |
|---|---|---|---|
| Auth | `login.usecase.ts` | `backend/src/application/auth/` | `auth.routes.ts` |
| Order | `order.usecases.ts` | `backend/src/application/order/` | `order.routes.ts` |
| Cash Flow | `cash-flow.usecases.ts` | `backend/src/application/cash-flow/` | `cash-flow.routes.ts` |
| Stock | `stock.usecases.ts` | `backend/src/application/stock/` | `misc.routes.ts` (estoque) |
| Purchase | `purchase.usecases.ts` | `backend/src/application/purchase/` | `misc.routes.ts` (compras) |
| Delivery | `calcular-entrega.usecase.ts` | `backend/src/application/delivery/` | `courier.routes.ts`, `delivery-manager.routes.ts` |
| Delivery | `delivery-pricing.usecase.ts` | `backend/src/application/delivery/` | `courier.routes.ts` |
| Delivery | `geocode-restaurant.usecase.ts` | `backend/src/application/delivery/` | `misc.routes.ts` (geocode) |
| Self-Service | `cart.usecases.ts` | `backend/src/application/self-service/` | `public.routes.ts` |
| Self-Service | `order-intake.usecase.ts` | `backend/src/application/self-service/` | `public.routes.ts` |
| Self-Service | `cancel-order.usecase.ts` | `backend/src/application/self-service/` | `public.routes.ts` |
| Self-Service | `customer-address.usecases.ts` | `backend/src/application/self-service/` | `misc.routes.ts` (customers) |
| Self-Service | `menu.usecases.ts` | `backend/src/application/self-service/` | `public.routes.ts` |
| Self-Service | `whatsapp-bot.usecases.ts` | `backend/src/application/self-service/` | `whatsapp-webhook.routes.ts` |
| WhatsApp | `whatsapp.usecases.ts` | `backend/src/application/whatsapp/` | `whatsapp.routes.ts` |
| Alert | `alert.usecases.ts` | `backend/src/application/alert/` | `alert.routes.ts` |
| Audit | `audit-log.usecases.ts` | `backend/src/application/` | `misc.routes.ts` (audit-log) |
| Report | `report.usecases.ts` | `backend/src/application/` | `misc.routes.ts` (reports) |
| User | `user.usecases.ts` | `backend/src/application/` | `misc.routes.ts` (users) |
| Customer | `customer.usecases.ts` | `backend/src/application/` | `misc.routes.ts` (customers) |
| Customer (CPF) | `cpf.ts` | `backend/src/domain/` | `misc.routes.ts` (customers) — valida DV, devolve os 11 dígitos crus |
| Product | `product.usecases.ts` | `backend/src/application/` | `misc.routes.ts` (products) |
| Category | `category.usecases.ts` | `backend/src/application/` | `misc.routes.ts` (categories) |
| Kitchen Group | `kitchen-group.usecases.ts` | `backend/src/application/` | `misc.routes.ts` (kitchen-groups) |
| Store Settings | `store-settings.usecases.ts` | `backend/src/application/` | `misc.routes.ts` (store-settings) |
| Payment | `payment.usecases.ts` | `backend/src/application/payment/` | `payment.routes.ts`, `pagarme-webhook.routes.ts` |
| Payment (domínio) | `payment.ts` | `backend/src/domain/` | `PaymentGateway`, transições de status, `refundableAmount` |

## Rotas (HTTP Layer)

| Arquivo | Domínio | Endpoints |
|---|---|---|
| `auth.routes.ts` | Autenticação | `/auth/users`, `/auth/login` |
| `order.routes.ts` | Comandas | `/orders`, `/orders/:id`, `/orders/:id/items`, `/orders/:id/payments`, `/orders/:id/close`, `/tables` |
| `cash-flow.routes.ts` | Fluxo de Caixa | `/cash-drawer/*` |
| `courier.routes.ts` | Entregas (Entregador) | `/courier/deliveries/*` |
| `delivery-manager.routes.ts` | Entregas (Gerente) | `/manager/deliveries/*`, `/manager/couriers` |
| `kitchen.routes.ts` | Cozinha | `/kitchen/orders`, `/kitchen/orders/:id/items/:itemId/ready` |
| `alert.routes.ts` | Alertas | `/alerts`, `/alerts/mark-read` |
| `print.routes.ts` | Impressão | `/orders/:id/print`, `/printers/status`, `/printers/health` |
| `misc.routes.ts` | Diversos | `/products`, `/categories`, `/kitchen-groups`, `/users`, `/customers`, `/reports/sales`, `/stock`, `/suppliers`, `/purchases`, `/inventory/value`, `/audit-log`, `/store-settings` |
| `public.routes.ts` | Público | `/public/menu`, `/public/orders`, `/public/orders/:id`, `/public/orders/:id/cancel`, `/public/orders/:id/status` |
| `whatsapp.routes.ts` | WhatsApp | `/whatsapp/status`, `/whatsapp/connect`, `/whatsapp/disconnect`, `/whatsapp/history` |
| `whatsapp-webhook.routes.ts` | Webhooks | `/webhooks/whatsapp` |
| `realtime.routes.ts` | Realtime | `/realtime` (WebSocket) |
| `ifood.routes.ts` | iFood | `/ifood/status`, `/ifood/catalog-sync` |
| `payment.routes.ts` | Cobrança (Pagar.me) | `/orders/:id/payments`, `/payments/:paymentId`, `/payments/:paymentId/cancel`, `/payments/:paymentId/refund` |
| `pagarme-webhook.routes.ts` | Webhooks | `/webhooks/pagarme` (público; assinatura verificada) |
| `uploads.routes.ts` | Storage | `/uploads/:kind/:filename` |

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
| `test/whatsapp.test.ts` | WhatsApp |

## Infraestrutura

| Componente | Arquivo |
|---|---|
| DB Client | `backend/src/infra/db/client.ts` |
| Migrations | `backend/src/infra/db/migrate.ts` |
| Seed | `backend/src/infra/db/seed.ts` |
| Load Menu | `backend/src/infra/db/load-menu.ts` |
| Outbox Dispatcher | `backend/src/infra/realtime/outbox-dispatcher.ts` |
| WebSocket | `backend/src/infra/realtime/ws-gateway.ts` |
| Maintenance | `backend/src/infra/maintenance.ts` |
| Advisory locks (dono único dos workers) | `backend/src/infra/locks.ts` |
| Cache | `backend/src/infra/cache/` |

## Integrações

| Integração | Arquivos |
|---|---|
| iFood | `backend/src/integrations/ifood/` (10 arquivos) |
| Google Maps | `backend/src/integrations/maps/` (3 arquivos) |
| Printer | `backend/src/integrations/printer/` (3 arquivos) |
| WhatsApp | `backend/src/integrations/whatsapp/` (6 arquivos) |
| Pagar.me | `backend/src/integrations/pagarme/` (7 arquivos) |
