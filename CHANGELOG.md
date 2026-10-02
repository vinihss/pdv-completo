# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não publicado]

### Corrigido

- **Impressão pelo botão do app perdia endereço e telefone no cupom do entregador.** O mapper do daemon (`entities/printer/lib/daemonOrder.js`) já lia `order.delivery` e `order.customerPhone`, e a API não mandava nenhum dos dois. Agora `GET /orders` e `GET /orders/:id` devolvem `delivery` e `customerPhone` — a impressão automática do backend já mandava, só a manual não.

### Adicionado

- **Card de entrega mostra quem pediu e quando.** A aba Entregas do gerente passou a exibir nome do cliente, endereço e a data em que o pedido caiu (e a de conclusão, quando houver). O clique no card abre a comanda. `GET /manager/deliveries` ganhou `customerName` e `createdAt` — a coluna existia e era usada só no `orderBy`, nunca saía na resposta — e passou a ordenar da mais nova pra mais antiga (a fila do entregador continua da mais antiga pra mais nova, de propósito).
- **Endereço na tela da comanda.** Comanda de entrega mostra o endereço logo abaixo do cabeçalho, no primeiro toque. O bloco vem embutido em `order.delivery`; lista e detalhe devolvem o mesmo shape, senão o endereço só apareceria depois de alguma recarga.
- **Spinner de carregamento no login.** A tela de login agora exibe uma animação de garrafas de cerveja como loader da página enquanto a lista de usuários e as informações da loja são buscadas do backend.

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
