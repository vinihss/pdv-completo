# Índice de Endpoints da API

Todos os endpoints do backend, agrupados por domínio. Para detalhes completos, ver `docs/01-backend-spec.md`.

## Autenticação

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/auth/users` | público | Lista usuários ativos (respeita toggles de rollout) |
| POST | `/auth/login` | público | Login por PIN (rate limit) |

## Comandas (Orders)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| POST | `/orders` | waiter, manager | Abrir comanda (idempotente) |
| GET | `/orders` | waiter, manager | Listar comandas |
| GET | `/orders/:id` | waiter, manager | Detalhe da comanda |
| POST | `/orders/:id/items` | waiter, manager | Lançar itens em lote (idempotente) |
| PATCH | `/orders/:id/items/:itemId` | waiter, manager | Atualizar item (lock otimista) |
| DELETE | `/orders/:id/items/:itemId` | waiter, manager | Remover item |
| PATCH | `/orders/:id/status` | waiter, manager | Mudar status (open/closed/cancelled) |
| PATCH | `/orders/:id/close` | waiter, manager | Fechar comanda (idempotente) |
| PUT | `/orders/:id/payments` | waiter, manager | Registrar pagamento |
| PATCH | `/orders/:id/payments/:paymentId` | waiter, manager | Confirmar pagamento |
| DELETE | `/orders/:id/payments/:paymentId` | waiter, manager | Remover pagamento |
| PATCH | `/orders/:id/payment` | waiter, manager | Legado: pagamento de intenção única |

## Mesas (Tables)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/tables` | waiter, manager | Listar mesas |
| POST | `/tables` | manager | Criar mesa |
| PATCH | `/tables/:id` | manager | Atualizar mesa |

## Cozinha (Kitchen)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/kitchen/orders` | kitchen, manager | Listar comandas para a cozinha |
| PATCH | `/kitchen/orders/:id/items/:itemId/ready` | kitchen | Marcar item como pronto |

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
| GET | `/manager/deliveries` | manager | Listar todas as entregas |
| PATCH | `/manager/deliveries/:id/assign` | manager | Atribuir entregador |
| GET | `/manager/couriers` | manager | Listar entregadores |

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
| GET | `/categories` | público | Listar categorias |
| POST | `/categories` | manager | Criar categoria |
| PATCH | `/categories/:id` | manager | Atualizar categoria |
| DELETE | `/categories/:id` | manager | Remover categoria |
| GET | `/kitchen-groups` | público | Listar grupos de produção |
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
| GET | `/customers/:id` | manager, cashier | Detalhe + endereços |
| POST | `/customers` | manager, cashier, waiter | Criar cliente |
| PATCH | `/customers/:id` | manager, cashier | Editar/soft-delete/reativar |
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

## Alertas (Alerts)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/alerts` | público* | Listar alertas (recorte por papel no usecase) |
| POST | `/alerts/mark-read` | público* | Marcar como lido |

\* Sem `requireRole` — o recorte por papel é feito no usecase.

## Impressão (Print)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| POST | `/orders/:id/print` | manager, waiter | Imprimir comanda |
| GET | `/printers/status` | manager, waiter | Status da impressora |
| GET | `/printers/health` | manager, waiter | Health da impressora |

## Configurações (Store Settings)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/store-settings` | público | Obter configurações |
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
| POST | `/whatsapp/connect` | manager | Iniciar Embedded Signup |
| POST | `/whatsapp/disconnect` | manager | Desconectar |
| GET | `/whatsapp/history` | manager | Histórico de mensagens |

## iFood

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/ifood/status` | manager | Status da integração |
| POST | `/ifood/catalog-sync` | manager | Sincronizar catálogo |

## Público (Self-Service)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/public/menu` | público | Cardápio público |
| POST | `/public/orders` | público | Criar pedido (self-service) |
| GET | `/public/orders/:id` | público | Detalhe do pedido |
| POST | `/public/orders/:id/cancel` | público | Cancelar pedido |
| GET | `/public/orders/:id/status` | público | Status do pedido |

## Webhooks

| Método | Path | Papel | Descrição |
|---|---|---|---|
| POST | `/webhooks/whatsapp` | público | Webhook da Meta (assinatura verificada) |

## Realtime (WebSocket)

| Método | Path | Papel | Descrição |
|---|---|---|---|
| WS | `/realtime` | token | Conexão WebSocket (token como subprotocol) |

## Health

| Método | Path | Papel | Descrição |
|---|---|---|---|
| GET | `/health` | público | Health check (só responde após migrations) |
