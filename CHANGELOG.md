# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não publicado]

### Corrigido

- **Impressão pelo botão do app perdia endereço e telefone no cupom do entregador.** O mapper do daemon (`entities/printer/lib/daemonOrder.js`) já lia `order.delivery` e `order.customerPhone`, e a API não mandava nenhum dos dois. Agora `GET /orders` e `GET /orders/:id` devolvem `delivery` e `customerPhone` — a impressão automática do backend já mandava, só a manual não.

### Adicionado

- **Camada de pagamentos Pagar.me V5 (Pix e cartão).** Cobrança no gateway com webhook idempotente, reconciliação e estorno parcial. O domínio não conhece o Pagar.me: `PaymentGateway` em `domain/payment.ts`, `PagarmeGateway` em `integrations/pagarme/`. Migration `0008` cria `payment` (a cobrança), `payment_event` (a inbox do webhook, com `UNIQUE (provider, event_id)`) e `payment_refund`. Quando o webhook confirma `paid`, a aplicação escreve uma linha confirmada em `order_payment` para a comanda fechar e o relatório enxergar o dinheiro — `payment` e `order_payment` coexistem porque o Pagar.me saber que o Pix foi pago não põe dinheiro na gaveta. Sem RabbitMQ: a fila é a própria tabela, drenada por worker com advisory lock. Detalhes e decisões em `docs/19-pagarme.md`.
- **Card de entrega mostra quem pediu e quando.** A aba Entregas do gerente passou a exibir nome do cliente, endereço e a data em que o pedido caiu (e a de conclusão, quando houver). O clique no card abre a comanda. `GET /manager/deliveries` ganhou `customerName` e `createdAt` — a coluna existia e era usada só no `orderBy`, nunca saía na resposta — e passou a ordenar da mais nova pra mais antiga (a fila do entregador continua da mais antiga pra mais nova, de propósito).
- **Endereço na tela da comanda.** Comanda de entrega mostra o endereço logo abaixo do cabeçalho, no primeiro toque. O bloco vem embutido em `order.delivery`; lista e detalhe devolvem o mesmo shape, senão o endereço só apareceria depois de alguma recarga.

## [1.44.0] - 2026-10-09

### Adicionado

- **`scripts/build/install-cli.sh` — compila e instala o CLI Go `pdv`.** O script roda `go build` em `cmd/pdv` (exige Go ≥ 1.25, o mínimo declarado no `go.mod`) e instala o binário em `$PREFIX/bin` (default `/usr/local/bin/pdv`); aceita `--uninstall`, um prefixo posicional e `PDV_CLI_GOFLAGS` para flags extras do build. Como o CLI localiza a raiz do repositório pelo diretório atual (ou pela env `PDV_ROOT`), rode-o de dentro de um checkout do projeto ou exporte `PDV_ROOT`.

## [1.43.0] - 2026-10-09

### Corrigido

- **Multi-tenant: cada loja serve a própria marca.** Resolução host → schema com escopo propagado (ALS) no Fastify, pool por schema, caches particionados por schema e leitura do `store_settings` do tenant resolvido na vitrine pública — `/public/tenants/resolve` deixa de responder `503` para tenants provisionados e nunca expõe `schema_name` na resposta (PRs #155–#160).
- **Login resolvia o tenant manualmente quando o ALS não propagava contexto** (PR #155) e **Service Worker desativado + cache busting por query string** para matar o cache de assets multi-tenant (PRs #156–#158).

### Adicionado

- **CLI Go `pdv` com comandos de banco.** `cmd/pdv` ganhou `db reset-pin <slug> [pin]` (reinicia o PIN do gerente de um tenant, com PIN automático de 4 dígitos) e `db list` (lista os tenants do registry) — `./pdv db reset-pin` e `./pdv db list` (PR #161).

## [1.0.0] - 2026-09-28

### Visão geral

PDV completo para restaurante/pub: backend (Node.js + Fastify + Drizzle + PostgreSQL), frontend (React + Vite + Tauri), deploy azul/verde com gap zero, impressão térmica, WhatsApp, estoque profissional e central de alertas.

### Fases concluídas

| Fase | Nome | Itens |
|---|---|---|
| 1 | Bugs de corretude | 8/8 |
| 2 | Robustez operacional e segurança | 6/6 |
| 5 | Estoque (ledger + UI) | 2/2 |
| 8 | Clientes, equipe e catálogo | 3/3 |
| 9 | Impressão térmica | 1/1 |

### Fases parciais

| Fase | Nome | Concluído | Pendente |
|---|---|---|---|
| 3 | Qualidade e refactor | 2/7 | lint backend, N+1, código morto, debounce, divergências de spec |
| 4 | Features pendentes da spec | 1/4 | cloud, backup, buffer WS |
| 6 | Estoque profissional | 2/3 | contagem, lote/validade, multi-depósito |
| 7 | WhatsApp | 3/4 | revogação token, reconciliação, quality_rating |
| 10 | Central de alertas | 4/5 | push de read_at, outros kinds |
| 11 | Deploy sem downtime | 2/3 | dono único do outbox |

### Destaques técnicos

- **Backend**: ESM + NodeNext, camadas (domain/application/infra/http), transações assíncronas, idempotência com correlationId, lock otimista, outbox pattern, migrations expand/contract
- **Frontend**: FSD (Feature-Sliced Design), sem lib de estado, server-authoritative, PWA instalável, app Windows (Tauri)
- **Deploy**: azul/verde com gap HTTP zero, Caddy reload, healthcheck como portão, stream_close_delay para WebSockets
- **Integrações**: WhatsApp Cloud API (Embedded Signup v4), iFood, Google Maps, impressora térmica (daemon Go sidecar)

### Pendências conhecidas

- Buffer de eventos perdidos no reconnect do WebSocket
- Backup automático (cron não agendado)
- Dono único do outbox (advisory lock do Postgres)
- Revogação do token WhatsApp na API da Meta
- Contagem/inventário, lote/validade (FIFO/FEFO), multi-depósito
