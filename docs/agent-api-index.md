# Índice de Endpoints da API

Todos os endpoints do backend, agrupados por domínio. Para detalhes completos, ver `docs/01-backend-spec.md`.

**Critério desta lista:** só entra aqui o que está registrado no código, em
`backend/src/http/routes/*.ts` (mais `/health`, registrado em `http/server.ts`).
Endpoint planejado ou apenas especificado **não entra aqui** — vai para
`docs/14-usabilidade-e-processos.md` (§ *Endpoints documentados e ainda não
implementados*). Se uma linha desta tabela não tiver rota no código, ela está
errada: corrija o doc ou a rota, não deixe as duas coisas divergirem em
silêncio.

Para reconferir depois de mexer em rotas (o `-0777` é necessário: boa parte
das rotas tem `app.post(` numa linha e o path na seguinte):

```bash
perl -0777 -ne 'while (/app\.(get|post|patch|put|delete)\s*\(\s*"([^"]*)"/g) {
  print uc($1), " $2\n" }' backend/src/http/routes/*.ts | sort -u
```

## Autenticação

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/auth/users` | público | Lista usuários ativos (respeita toggles de rollout) |
| POST | `/auth/login` | público | Login por PIN (rate limit) |

## Comandas (Orders)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| POST | `/orders` | waiter, manager | Abrir comanda (idempotente) |
| GET | `/orders` | autenticado\* | Listar comandas (fonte também do KDS) |
| GET | `/orders/:id` | autenticado\* | Detalhe da comanda |
| POST | `/orders/:id/items` | waiter, manager | Lançar itens em lote (idempotente) |
| PATCH | `/orders/:id/items/:itemId` | autenticado\* | Atualizar item (lock otimista) |
| DELETE | `/orders/:id/items/:itemId` | waiter, manager | Remover item |
| PATCH | `/orders/:id/close` | waiter, manager | Fechar comanda (idempotente) |
| PATCH | `/orders/:id/cancel` | manager | Anular comanda sem venda (idempotente) |
| PUT | `/orders/:id/payments` | waiter, manager | Registrar pagamento |
| PATCH | `/orders/:id/payments/:paymentId` | waiter, manager | Confirmar pagamento |
| DELETE | `/orders/:id/payments/:paymentId` | waiter, manager | Remover pagamento |
| PATCH | `/orders/:id/payment` | waiter, manager | Legado: pagamento de intenção única |

## Mesas (Tables)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/tables` | autenticado\* | Listar mesas (com status free/occupied/closing) |

## Cozinha (Kitchen)

A cozinha não tem rota própria: o KDS lê comandas por `GET /orders?status=open`,
filtra por `kitchenGroupId` no cliente e marca item por `PATCH
/orders/:id/items/:itemId` com `status: "ready"`. As três rotas já estão
listadas nas seções **Comandas** e **Catálogo** — não são repetidas aqui.

## Fluxo de Caixa (Cash Flow)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/cash-drawer/current` | cashier, manager | Caixa atual |
| GET | `/cash-drawer` | cashier, manager | Listar caixas |
| GET | `/cash-drawer/summary` | cashier, manager | Resumo por período |
| GET | `/cash-drawer/:id` | cashier, manager | Detalhe do caixa |
| POST | `/cash-drawer/open` | cashier, manager | Abrir caixa |
| POST | `/cash-drawer/sangria` | cashier, manager | Sangria (idempotente) |
| POST | `/cash-drawer/suprimento` | cashier, manager | Suprimento (idempotente) |
| POST | `/cash-drawer/close` | cashier, manager | Fechar caixa (idempotente) |

## Entregas (Deliveries)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/courier/deliveries` | courier | Entregas atribuídas ao entregador |
| PATCH | `/courier/deliveries/:id/dispatch` | courier | Despachar entrega |
| PATCH | `/courier/deliveries/:id/deliver` | courier | Marcar como entregue |
| PATCH | `/courier/deliveries/:id/fail` | courier | Marcar como falha |
| GET | `/manager/deliveries` | manager | Listar todas as entregas (com `distanceKm`/`estimatedMinutes` e `addressLatitude`/`addressLongitude` por card) |
| PATCH | `/manager/deliveries/:id/assign` | manager | Atribuir entregador |
| PATCH | `/manager/deliveries/:id/status` | manager | Mudar status da entrega |
| GET | `/manager/couriers` | manager | Listar entregadores |
| POST | `/courier/location` | courier | Ping de localização (upsert; só com entrega `out_for_delivery`, senão 409 `courier_not_on_route`; publica `courier.location` no room `deliveries` com `courierName`/`photoPath`) |
| GET | `/manager/deliveries/locations` | manager | Última posição dos entregadores com entrega em rota (com `courierName` e `photoPath`) |

## Catálogo (Products & Categories)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/products` | manager, waiter, kitchen | Listar produtos |
| POST | `/products` | manager | Criar produto |
| PATCH | `/products/:id` | manager | Atualizar produto |
| PATCH | `/products/:id/deactivate` | manager | Desativar produto |
| PATCH | `/products/:id/activate` | manager | Ativar produto |
| POST | `/products/:id/image` | manager | Upload de imagem |
| DELETE | `/products/:id/image` | manager | Remover imagem |
| GET | `/categories` | autenticado\* | Listar categorias |
| POST | `/categories` | manager | Criar categoria |
| PATCH | `/categories/:id` | manager | Atualizar categoria |
| DELETE | `/categories/:id` | manager | Remover categoria |
| GET | `/kitchen-groups` | autenticado\* | Listar grupos de produção |
| POST | `/kitchen-groups` | manager | Criar grupo |
| PATCH | `/kitchen-groups/:id` | manager | Atualizar grupo |
| DELETE | `/kitchen-groups/:id` | manager | Remover grupo |

## Estoque (Stock)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/stock` | manager | Listar estoque |
| GET | `/stock/movements` | manager | Listar movimentos |
| POST | `/stock/:productId/movements` | manager | Movimento manual (idempotente) |
| GET | `/inventory/value` | manager | Valorização do estoque |

## Compras (Purchases)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/suppliers` | manager | Listar fornecedores |
| POST | `/suppliers` | manager | Criar fornecedor |
| PATCH | `/suppliers/:id` | manager | Atualizar fornecedor |
| POST | `/purchases` | manager | Criar compra (idempotente) |
| GET | `/purchases` | manager | Listar compras |
| GET | `/purchases/:id` | manager | Detalhe da compra |

## Clientes (Customers)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/customers/search` | manager, cashier, waiter | Busca leve (só ativos) |
| GET | `/customers` | manager, cashier | Lista paginada |
| GET | `/customers/:id` | manager, cashier | Detalhe + endereços + comandas abertas |
| GET | `/customers/:id/orders` | manager, cashier | Histórico de comandas (paginado) |
| GET | `/customers/:id/summary` | manager, cashier | Consumo por dia (`?days=30&tz=-03:00`) |
| POST | `/customers` | manager, cashier, waiter | Criar cliente |
| PATCH | `/customers/:id` | manager, cashier | Editar/soft-delete/reativar |
| POST | `/customers/:id/photo` | manager, cashier | Upload de foto |
| DELETE | `/customers/:id/photo` | manager, cashier | Remover foto |
| POST | `/customers/:id/addresses` | manager, cashier | Adicionar endereço |
| POST | `/customers/:id/addresses/:addressId/default` | manager, cashier | Marcar como padrão |
| DELETE | `/customers/:id/addresses/:addressId` | manager, cashier | Remover endereço |

## Equipe (Users)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/users` | manager | Listar usuários |
| POST | `/users` | manager | Criar usuário |
| PATCH | `/users/:id` | manager | Atualizar usuário |
| PATCH | `/users/:id/reset-pin` | manager | Resetar PIN |
| POST | `/users/:id/photo` | manager | Upload de foto |
| DELETE | `/users/:id/photo` | manager | Remover foto |

## Relatórios (Reports)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/reports/sales` | manager | Relatório de vendas |
| GET | `/reports/overview` | manager | Visão geral do período |
| GET | `/reports/deliveries` | manager | Relatório de entregas |

## Alertas (Alerts)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/alerts` | autenticado\* | Listar alertas (recorte por papel no usecase) |
| POST | `/alerts/mark-read` | autenticado\* | Marcar como lido |

\* Exige token, mas **sem `requireRole`**: qualquer perfil autenticado entra e o
recorte é feito no usecase (por `audience_roles` nos alertas, por regra própria
em cada caso). "autenticado" ≠ "público": rota sem token nenhum é só a de
`/auth/*`, `/public/*`, `/webhooks/*`, `/realtime/public` e `/health`.

## Impressão (Print)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| POST | `/orders/:id/print` | manager, waiter | Imprimir comanda |
| GET | `/orders/:id/print-status` | manager, waiter | Jobs de impressão da comanda |
| GET | `/printers/status` | manager | Status da impressora |
| GET | `/printers/health` | manager | Health da impressora |

## Configurações (Store Settings)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/store-settings` | autenticado\* | Obter configurações |
| PUT | `/store-settings` | manager | Atualizar configurações |
| POST | `/store-settings/logo` | manager | Upload de logo |
| DELETE | `/store-settings/logo` | manager | Remover logo |
| POST | `/store/geocode-restaurant` | manager | Geocodificar endereço |

## Auditoria (Audit Log)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/audit-log` | manager | Listar logs de auditoria |

## WhatsApp

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/whatsapp/status` | manager | Status da conexão |
| GET | `/whatsapp/config` | manager | App id e config id públicos (monta o `FB.login`) |
| POST | `/whatsapp/embedded-signup/exchange` | manager | Fecha o Embedded Signup (troca o `code`; uso único) |
| POST | `/whatsapp/disconnect` | manager | Desconectar (apaga o token) |
| GET | `/whatsapp/messages` | manager | Histórico de mensagens com status da Meta |

## iFood

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/ifood/status` | manager | Status da integração |
| POST | `/ifood/catalog-sync` | manager | Sincronizar catálogo |

## Público (Self-Service)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/public/menu` | público | Cardápio público |
| GET | `/public/tenants/resolve` | público | Resolve a loja pelo `host` (query, `X-Tenant-Host` ou `Host`); 404 `found:false` se não for loja, 403 se suspensa |
| POST | `/public/customers/lookup` | público | Busca cliente por telefone |
| POST | `/public/customers` | público | Criar cliente no checkout |
| POST | `/public/customers/:id/addresses` | público | Adicionar endereço no checkout |
| POST | `/public/orders` | público | Criar pedido (self-service) |
| POST | `/public/orders/active` | público | Pedido em andamento por telefone (retomada) |
| POST | `/public/orders/:id/cancel` | público | Cancelar pedido (telefone precisa bater) |
| GET | `/public/orders/:id/status` | público | Status do pedido |
| GET | `/public/cart` | público | Ler carrinho rascunho por telefone |
| PUT | `/public/cart` | público | Salvar carrinho rascunho |
| DELETE | `/public/cart` | público | Limpar carrinho rascunho |
| POST | `/calcular-entrega` | público | Calcular taxa e prazo de entrega |

### `GET /public/tenants/resolve`

Único endpoint do multi-tenant (schema-por-tenant) que existe hoje: a vitrine de
pedidos (`apps/pedido-public`) pergunta **em qual loja** está antes de qualquer
outra chamada. Detalhe em `docs/15-multi-tenant-schema.md` §6 (Fase 1).

- **Sem autenticação** e com o rate limit de lookup público (20/min por IP).
- O host vem de `?host=`, de `X-Tenant-Host` (que o Caddy injeta em `api.*`) ou
  do `Host`/`X-Forwarded-Host` da requisição — nessa ordem.
- `200` → `{ found: true, tenant: { storeId, slug, name, logoUrl, primaryColor, usesDelivery, kitchenEnabled } }`.
  O `schema_name` do banco **não** sai: é topologia interna.
- `404` → `{ found: false, error: { code: "tenant_not_resolved", … } }` (endereço
  não é loja nenhuma; nunca cai no tenant default).
- `403` → `tenant_inactive` (loja suspensa). `503` → `tenant_schema_unavailable`
  (a loja está no registry mas o processo ainda não fala o schema dela — só
  acontece entre a Fase 1 e a Fase 3).
- Com `TENANT_ROUTING=false` (o default) **nenhum** endereço dá 404: todo host
  resolve para o tenant default, que é o comportamento de antes do multi-tenant.

## Webhooks

| Método | Path | Papel | Descrição |
|---|---|---|---|
| POST | `/webhooks/whatsapp` | público | Webhook da Meta (assinatura verificada) |
| GET | `/webhooks/whatsapp` | público | Verificação de assinatura do webhook |
| POST | `/webhooks/pagarme` | público | Webhook do Pagar.me V5 (assinatura verificada; grava a inbox antes do 200) |

## Cobrança no Pagar.me (`payment`)

Cobrança no gateway — tabela `payment`, distinta de `order_payment` (que é a
linha registrada pela pessoa). Detalhe em `docs/19-pagarme.md`.

| Método | Path | Papel | Descrição |
|---|---|---|---|
| POST | `/orders/:id/payments` | cashier, manager | Criar cobrança (`pix`/`credit_card`; idempotente por `correlationId`) |
| GET | `/orders/:id/payments` | cashier, manager, waiter | Listar tentativas da comanda |
| GET | `/payments/:paymentId` | cashier, manager, waiter | Detalhe da cobrança |
| POST | `/payments/:paymentId/cancel` | cashier, manager | Cancelar cobrança pendente |
| POST | `/payments/:paymentId/refund` | manager | Estorno parcial ou integral |

### Canal interno (`pagarme-webhook/`)

Não é API de produto: é o único sentido de comunicação entre o backend Node e o
serviço Go que drena a inbox. O Go **pergunta**; o Node faz a transação
(`applyCharge`, `bridgePaidToOrder`, `audit_log`, `outbox_event`). Auth por token
opaco no header `X-Internal-Token` (alias: `Authorization: Bearer`), comparado em
tempo constante. Sem `PAGARME_INTERNAL_TOKEN` no servidor, tudo é recusado com 401.

O Caddy **não** expõe `/internal/*` (responde 404): o Go chega pela rede interna,
via `NODE_INTERNAL_URL`. Os status são contrato — o drainer Go decide entre
reenviar, `ignored` e DLQ a partir deles (200/401/404/422/5xx).

| Método | Path | Auth | Descrição |
|---|---|---|---|
| POST | `/internal/pagarme/events/:eventRowId/apply` | token | Aplica o evento da inbox (`:eventRowId` = `payment_event.id` local) |
| POST | `/internal/pagarme/charges/apply` | token | Aplica a cobrança relida do gateway (reconciliação) |

## Realtime (WebSocket)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| WS | `/realtime` | token | Conexão WebSocket (token como subprotocol) |
| WS | `/realtime/public` | público | Acompanhamento de pedido; sem JWT, `join` só em `order:<uuid>` |

## Health

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/health` | público | Health check (só responde após migrations) |
