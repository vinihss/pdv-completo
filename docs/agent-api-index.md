# Índice de Endpoints da API

Todos os endpoints do backend, agrupados por domínio. Para detalhes completos, ver `docs/01-backend-spec.md`.

**Critério desta lista:** só entra aqui o que está registrado no código, em
`backend/src/http/routes/*.ts` e módulos de rotas explicitamente registrados pelo router (mais `/health`, registrado em `http/server.ts`).
Endpoint planejado ou apenas especificado **não entra aqui** — anote no doc de
planejamento vigente. O antigo `docs/14-usabilidade-e-processos.md` (§ *Endpoints
documentados e ainda não implementados*) foi removido em `308c9977`; recupere com
`git show 308c9977^:docs/14-usabilidade-e-processos.md`. Se uma linha desta
tabela não tiver rota no código, ela está
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
| GET | `/auth/me` | autenticado\* | Perfil fresco do usuário logado (`serialize` completo — é dele que a tela de perfil tira `phone`/`email`, que o login não devolve) |
| PATCH | `/auth/me` | autenticado\* | Atualizar o próprio perfil (`name`, `phone`, `email`; id vem do token, campos de poder fora do contrato) |
| POST | `/auth/me/photo` | autenticado\* | Upload da própria foto (multipart, campo `photo`; jpeg/png/webp; id vem do token — par self-service de `/users/:id/photo`) |
| DELETE | `/auth/me/photo` | autenticado\* | Remover a própria foto (id vem do token) |

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
| POST | `/orders/:id/payments/:paymentId/refunds` | manager | Criar estorno (idempotente por `correlationId`; `refund.routes.ts`) |
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
| POST | `/courier/location` | courier | Ping de localização (upsert; só com entrega `out_for_delivery`, senão 409 `courier_not_on_route`; publica `courier.location` e, ao cruzar limite, `courier.region_changed` no room `deliveries`) |
| GET | `/manager/deliveries/locations` | manager | Última posição dos entregadores com entrega em rota (com `courierName` e `photoPath`) |
| GET | `/delivery-regions` | manager | Listar regiões de entrega em GeoJSON |
| POST | `/delivery-regions` | manager | Criar/atualizar região a partir de polígono GeoJSON |
| POST | `/delivery-regions/deliveries/:id/coordinate` | manager | Gravar coordenada da entrega e atribuir região via `ST_Contains` |
| POST | `/delivery-regions/:id/route` | manager | Otimizar sequência de paradas pendentes via OSRM Trip |
| POST | `/regioes/:id/roteirizar` | manager | Alias em português para roteirização OSRM |

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
`/public/*`, `/webhooks/*`, `/realtime/public` e `/health` — em `/auth/*`, só
`GET /auth/users` e `POST /auth/login` são públicos (`GET`/`PATCH /auth/me` e
`POST`/`DELETE /auth/me/photo` exigem sessão).

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

## iFood

> **Sem rotas no backend atual.** Não existe `backend/src/http/routes/ifood.routes.ts`
> nem integração em `src/integrations/ifood/` — o iFood está fora deste checkout
> (plano em `docs/18-ifood-por-loja.md`, **removido em `308c9977`**;
> `git show 308c9977^:docs/18-ifood-por-loja.md`).

## Público (Self-Service)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/public/menu` | público | Cardápio público |
| GET | `/public/tenants/resolve` | público | Resolve a loja pelo `host` (query, `X-Tenant-Host` ou `Host`); 404 `found:false` se não for loja, 403 se suspensa |
| POST | `/public/customers/lookup` | público | Busca cliente por telefone |
| POST | `/public/customers` | público | Criar cliente no checkout |
| POST | `/public/customers/:id/addresses` | público | Adicionar endereço no checkout |
| POST | `/public/orders` | público | Criar pedido (self-service); `channel` opcional (`web` ou `whatsapp`, padrão `web`) |
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
outra chamada. Detalhe no antigo `docs/15-multi-tenant-schema.md` §6 (Fase 1) —
removido em `308c9977`; recupere com
`git show 308c9977^:docs/15-multi-tenant-schema.md`.

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

## Webhooks e camada Pagar.me — fora da API do backend

Tudo abaixo foi **removido do backend Node** pela migration
`0010_remove_payment_ifood.sql` (tabelas `payment`, `payment_event`,
`payment_refund`, colunas `ifood_*`/`pagarme_enabled`) e pelo apagamento dos
arquivos de rota. Não existe nenhuma rota `/webhooks/*`, `/payments/*` ou
`/internal/pagarme/*` em `backend/src/http/routes/` hoje:

| O que a doc antiga listava | Estado atual |
|---|---|
| `POST /webhooks/pagarme` | removido — o webhook Pagar.me é recebido pelo serviço Go `pagarme-webhook/` (fora do backend); o serviço **ainda chama** `POST /internal/pagarme/...` no Node, que não existe mais (ver riscos abaixo) |
| `POST/GET /orders/:id/payments` como "cobrança no gateway", `GET/POST /payments/:paymentId*` | removidos — o que existe hoje são as **linhas de pagamento da comanda** em §Comandas (`order_payment`) + estorno em `POST /orders/:id/payments/:paymentId/refunds` |
| `POST /internal/pagarme/events/:id/apply`, `POST /internal/pagarme/charges/apply` | removidos do Node (sem tabela `payment_event` para gravar) |

Os docs `19-pagarme.md` e `20-pagarme-pendencias.md` (camada V5) foram
removidos em `308c9977`; recupere com
`git show 308c9977^:docs/19-pagarme.md` (idem `20-…`). Se o serviço Go `pagarme-webhook/`
for mantido no deploy, o contrato `/internal/pagarme/*` precisa ser restaurado
ou o serviço desligado — isso é uma pendência de deploy, não de API.

## Realtime (WebSocket)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| WS | `/realtime` | token | Conexão WebSocket (token como subprotocol) |
| WS | `/realtime/public` | público | Acompanhamento de pedido; sem JWT, `join` só em `order:<uuid>` |

## Health

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/health` | público | Health check (só responde após migrations) |
