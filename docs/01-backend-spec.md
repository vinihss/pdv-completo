# Backend Specification — POS System (Stage 1)

## 1. Escopo da Etapa 1

Incluído:
- Cadastro de produtos (sem ficha técnica; com controle de estoque simples — saldo por produto via ledger, ver §7.5 e `07-estoque.md`)
- Configuração de usuários (waiter, kitchen, manager)
- Mesas e comandas (orders), com suporte a identificação por mesa, cliente cadastrado ou rótulo livre
- Configuração da loja: uso de mesas (liga/desliga), uso da tela da cozinha (liga/desliga) e formas de pagamento habilitadas
- Lançamento de itens de pedido, com revisão em lote antes de confirmar e remoção de item ainda não entregue
- Gerenciamento de categorias (criar, renomear, reordenar, excluir)
- Fechamento de conta com confirmação explícita da forma de pagamento
- Geração de QR Code Pix estático para cobrança, com confirmação manual
- Log de auditoria de todas as ações relevantes (abertura/fechamento de comanda, item adicionado/removido/entregue)
- **Gerente com acesso completo à operação de comandas** — não só a função de caixa (fechar conta): abrir comanda, lançar/remover item, marcar entregue, tudo que o garçom faz, com a mesma interface e as mesmas regras de negócio (§7.2, §9)
- **Relatório de vendas para o gerente** — total vendido, ticket médio e detalhamento por forma de pagamento, com filtro por período, cliente/mesa e produto (§7.11)
- **Controle de estoque simples** — saldo por produto (ledger de movimentos), débito automático no lançamento, entrada/ajuste manual pelo gerente, alerta de estoque baixo e margem por produto no relatório (§7.5, §7.9 e `07-estoque.md`)

Explicitamente fora do escopo:
- **Ficha técnica** (baixa automática por ingrediente/quantidade de receita) — o estoque atual é por produto com `track_stock`, ligado/desligado edição manual
- Processamento automático de pagamento — não há integração com PSP/adquirente, não há webhook de confirmação, não há reconciliação automática. Pix é apenas geração de cobrança (BR Code); a confirmação de recebimento é sempre uma ação manual do gerente/garçom após conferir o extrato bancário
- Emissão fiscal (NFC-e/SAT)
- Roteamento automático de pedido para estações de produção (cozinha/bar)

## 2. Stack

| Camada | Tecnologia | Racional |
|---|---|---|
| Runtime | Node.js (LTS) + TypeScript | tipagem forte, ecossistema maduro |
| HTTP framework | Fastify | baixo overhead, adequado para terminal local |
| ORM/Query builder | Drizzle | SQL-first sobre PostgreSQL (`node-postgres`) |
| Real-time | WebSocket (`@fastify/websocket`) | atualização de status entre telas |
| Validação | Zod | schemas reusáveis entre camadas |
| Auth | JWT + PIN numérico (argon2) | login rápido em ambiente compartilhado |

## 3. Modelo de Implantação

Dois modos de deployment sobre o mesmo código-fonte:

- **local**: aplicação + banco rodam em um servidor físico (mini-PC/NUC) dentro do estabelecimento, via Docker. Terminais (tablets) acessam via Wi-Fi interno. Não depende de internet para operar.
- **cloud**: mesma aplicação, sobe em servidor gerenciado (ex: RDS/Supabase). Terminais acessam via internet normal. Sem hardware físico no cliente. Não é offline-first — se a internet cair, o sistema para.

Variação é só configuração:

```typescript
// config/env.ts
> **Atualização 2026**: o SQLite foi **removido** do produto. `DATABASE_URL` é
> sempre `postgres://` e `syncEnabled` saiu do config (não havia implementação).

export const config = {
  deploymentMode: process.env.DEPLOYMENT_MODE, // 'local' | 'cloud'
  databaseUrl: process.env.DATABASE_URL,        // postgres://user:pass@host:5432/db
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),
}
```

Sincronização opcional (modo local → cloud) roda como serviço separado, sem interferir na aplicação principal. Serve para backup/disaster recovery, relatórios remotos, e futura consolidação multi-unidade.

## 4. Schema de Banco de Dados

```sql
-- ============================================================
-- SCHEMA: POS System - Stage 1 (Core Operations)
-- Scope: No inventory, no payment processing, no fiscal, no auto-routing
-- ============================================================

CREATE TYPE user_role AS ENUM ('waiter', 'kitchen', 'manager');
CREATE TYPE table_status AS ENUM ('free', 'occupied', 'closing');
CREATE TYPE order_status AS ENUM ('open', 'closed');
CREATE TYPE order_item_status AS ENUM ('ordered', 'ready', 'delivered', 'cancelled');

CREATE TABLE "user" (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120) NOT NULL,
    role            user_role NOT NULL,
    pin_hash        VARCHAR(255) NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE category (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(80) NOT NULL,
    display_order   INTEGER NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id     UUID NOT NULL REFERENCES category(id) ON DELETE RESTRICT,
    name            VARCHAR(150) NOT NULL,
    price           NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    variations      JSONB NOT NULL DEFAULT '[]',
    -- variations format: [{"name": "point", "options": ["rare","medium","well_done"]}]
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_category ON product(category_id);

CREATE TABLE restaurant_table (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          VARCHAR(20) NOT NULL UNIQUE,
    status          table_status NOT NULL DEFAULT 'free',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120) NOT NULL,
    phone           VARCHAR(20),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_name ON customer(name);
CREATE INDEX idx_customer_phone ON customer(phone);

CREATE TABLE "order" (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id        UUID REFERENCES restaurant_table(id) ON DELETE RESTRICT, -- nullable: pub sem mesa
    customer_id     UUID REFERENCES customer(id) ON DELETE SET NULL,
    tab_label       VARCHAR(60), -- ex: "Comanda 12", usado sem mesa e sem cliente cadastrado
    waiter_id       UUID NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    status          order_status NOT NULL DEFAULT 'open',
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ,
    payment_method      VARCHAR(20), -- denormalizado de exibição (seção 7.2): método único → ele; vários → NULL. Fonte da verdade é order_payment
    payment_confirmed_at TIMESTAMPTZ,
    payment_confirmed_by UUID REFERENCES "user"(id),
    CONSTRAINT order_identification_required
        CHECK (table_id IS NOT NULL OR customer_id IS NOT NULL OR tab_label IS NOT NULL)
);

CREATE INDEX idx_order_table ON "order"(table_id);
CREATE INDEX idx_order_customer ON "order"(customer_id);
CREATE INDEX idx_order_status ON "order"(status);

-- Pagamento fracionado: uma comanda pode ser paga com várias formas
-- (dinheiro + cartão + pix + ...). Cada "pedaço" é uma linha; o fechamento
-- exige soma dos pedaços == total e todos confirmados (seção 7.2). Valores
-- monetários NUMERIC(10,2) em reais, coerente com order_item.unit_price.
CREATE TABLE order_payment (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
    method          VARCHAR(20) NOT NULL CHECK (method IN ('cash','card','pix','other')),
    amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    received        NUMERIC(10,2), -- só cash: quanto o cliente entregou
    change          NUMERIC(10,2), -- só cash: received - amount (troco)
    confirmed       BOOLEAN NOT NULL DEFAULT false, -- Pix nasce false; dinheiro/cartão confirmam no registro
    confirmed_at    TIMESTAMPTZ,
    confirmed_by    UUID REFERENCES "user"(id),
    created_by      UUID NOT NULL REFERENCES "user"(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_payment_order ON order_payment(order_id);

CREATE TABLE order_item (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    unit_price      NUMERIC(10,2) NOT NULL, -- snapshot of product.price at order time
    selected_variations JSONB NOT NULL DEFAULT '{}',
    notes           TEXT,
    status          order_item_status NOT NULL DEFAULT 'ordered',
    version         INTEGER NOT NULL DEFAULT 1, -- optimistic locking
    created_by      UUID NOT NULL REFERENCES "user"(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_item_order ON order_item(order_id);
CREATE INDEX idx_order_item_status ON order_item(status);

CREATE VIEW order_running_total AS
SELECT
    o.id AS order_id,
    o.table_id,
    SUM(oi.unit_price * oi.quantity) FILTER (WHERE oi.status != 'cancelled') AS total
FROM "order" o
JOIN order_item oi ON oi.order_id = o.id
GROUP BY o.id, o.table_id;

-- Store settings (dados do estabelecimento, necessários para gerar o BR Code do Pix e parametrizar o app)
CREATE TABLE store_settings (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_name            VARCHAR(25) NOT NULL, -- limite do padrão BR Code (campo 59)
    merchant_city            VARCHAR(15) NOT NULL, -- limite do padrão BR Code (campo 60)
    pix_key                  VARCHAR(140) NOT NULL,
    pix_key_type             VARCHAR(20) NOT NULL, -- cpf | cnpj | email | phone | random
    uses_tables              BOOLEAN NOT NULL DEFAULT true, -- false = fluxo tipo pub, sem opção de mesa na abertura
    kitchen_enabled          BOOLEAN NOT NULL DEFAULT true, -- false = sem estação de cozinha; item pula "ready" e vai direto a "delivered"
    enabled_payment_methods  JSONB NOT NULL DEFAULT '["cash","card","pix","other"]', -- controla quais botões aparecem no fechamento
    kitchen_prep_warn_min    INTEGER NOT NULL DEFAULT 3, -- minutos em preparo até o cartão virar âmbar (tela da cozinha)
    kitchen_prep_urgent_min  INTEGER NOT NULL DEFAULT 6, -- minutos em preparo até o cartão virar vermelho pulsante
    kitchen_pickup_urgent_min INTEGER NOT NULL DEFAULT 5 -- minutos parado em "Prontos" até destacar como urgente
);
-- Tabela de linha única (singleton) nesta etapa: um estabelecimento por instância

-- Log de auditoria — toda ação relevante do garçom/gerente é registrada
CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES "user"(id),
    action      VARCHAR(50) NOT NULL, -- order_opened | item_added | item_removed | item_delivered | order_closed | ...
    order_id    UUID REFERENCES "order"(id),
    details     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_order ON audit_log(order_id);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);

CREATE TABLE idempotency_key (
    correlation_id  UUID PRIMARY KEY,
    endpoint        VARCHAR(100) NOT NULL,
    request_hash    VARCHAR(64) NOT NULL,
    response_body   JSONB,
    response_status INTEGER,
    status          VARCHAR(20) NOT NULL DEFAULT 'processing', -- processing | completed | failed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '15 minutes'
);

CREATE INDEX idx_idempotency_expires ON idempotency_key(expires_at);

-- Outbox pattern support (guarantees WS event delivery)
CREATE TABLE outbox_event (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type   VARCHAR(100) NOT NULL,
    payload      JSONB NOT NULL,
    room         VARCHAR(100) NOT NULL,
    published    BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Adições da migration `0016_inventory` (controle de estoque)

Sem tocar no schema acima, as migrations adicionam controlo de estoque
**por produto**, com padrões desligados (rollout seguro — ver `07-estoque.md`):

```sql
-- product: custo unitário atual, alerta de estoque baixo e flag de rastreamento
ALTER TABLE product      ADD COLUMN cost_price         NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE product      ADD COLUMN low_stock_threshold REAL NOT NULL DEFAULT 0;
ALTER TABLE product      ADD COLUMN track_stock        BOOLEAN NOT NULL DEFAULT false;

-- order_item: custo snapshot no lançamento (mesma disciplina do unit_price)
ALTER TABLE order_item   ADD COLUMN cost_price         NUMERIC(10,2) NOT NULL DEFAULT 0;

-- store_settings: liga/desliga o módulo
ALTER TABLE store_settings ADD COLUMN inventory_enabled BOOLEAN NOT NULL DEFAULT false;

-- Ledger: fonte da verdade do saldo (Σ quantity_delta), história auditável.
CREATE TABLE stock_movement (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id       UUID NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
    quantity_delta   REAL NOT NULL CHECK (quantity_delta != 0), -- sale/refund/purchase/adjustment
    movement_type    VARCHAR(20) NOT NULL CHECK (movement_type IN ('sale','refund','purchase','adjustment')),
    order_id         UUID REFERENCES "order"(id),       -- só sale/refund
    order_item_id    UUID REFERENCES order_item(id),    -- só sale/refund
    user_id          UUID NOT NULL REFERENCES "user"(id),
    note             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movement_product ON stock_movement(product_id, created_at);
CREATE INDEX idx_stock_movement_order    ON stock_movement(order_id);
CREATE INDEX idx_stock_movement_user     ON stock_movement(user_id);
```

O custo de `unit_price` em `order_item` é snapshot, não referência viva a
`product.price`.
- UUIDs como PK, adequados para futura sincronização multi-servidor.
- `version` em `order_item` suporta lock otimista (seção 6).
- **Identificação da order**: `table_id`, `customer_id` e `tab_label` são independentes entre si (não hierárquicos) — a constraint `order_identification_required` garante que ao menos um esteja preenchido. Isso suporta tanto o modelo de restaurante tradicional (mesa) quanto o de pub sem mesa (comanda vinculada a cliente cadastrado ou a um rótulo livre digitado na hora, sem exigir cadastro). `customer` é uma entidade própria (não um campo solto) para permitir busca por nome/telefone e reaproveitamento em visitas futuras, mesmo que histórico de consumo fique fora do escopo da etapa 1.

## 5. Arquitetura em Camadas

```
src/
├── domain/                  # regras de negócio puras, sem I/O
│   ├── order/
│   ├── product/
│   ├── table/
│   └── user/
│
├── application/              # use cases / orquestração
│   └── order/
│       ├── open-order.usecase.ts
│       ├── add-item.usecase.ts
│       ├── update-item-status.usecase.ts
│       └── close-order.usecase.ts
│
├── infra/
│   ├── repositories/
│   │   ├── order.repository.ts
│   │   └── interfaces/
│   │       └── order.repository.interface.ts
│   ├── db/
│   │   ├── schema.ts
│   │   └── client.ts
│   ├── realtime/
│   │   ├── ws-gateway.ts
│   │   └── outbox-dispatcher.ts
│   └── container.ts          # composition root (DI)
│
├── http/
│   ├── routes/
│   ├── middlewares/
│   │   ├── auth.middleware.ts
│   │   └── idempotency.middleware.ts
│   └── server.ts
│
└── config/
    └── env.ts
```

**Regra de dependência (dependency inversion):**

| Camada | Pode importar |
|---|---|
| `domain` | nada externo (regras puras) |
| `application` | interfaces de `infra` (nunca implementação concreta) |
| `infra` | `domain`, bibliotecas externas (Drizzle, ws, etc) |
| `http` | `container` (ponto único de acesso a `application`) |

Isso mantém a lógica de negócio desacoplada do banco: trocar o *destino* do
Postgres (compose local, RDS, Neon) é só `DATABASE_URL`, sem tocar em use case.
> **Atualização 2026**: com o SQLite removido, `infra/db/client.ts` fala só com
> o Postgres — não há mais troca de driver, só de endpoint.

## 6. Container de Injeção de Dependência

Composition root manual (sem lib de DI pesada — desnecessária nesta escala):

```typescript
// infra/container.ts
export function buildContainer(config: AppConfig) {
  const db = createDbClient(config.databaseUrl)
  const wsGateway = new WsGateway()

  const orderRepository = new DrizzleOrderRepository(db)
  const productRepository = new DrizzleProductRepository(db)
  const userRepository = new DrizzleUserRepository(db)

  const outboxDispatcher = new OutboxDispatcher(db, wsGateway)
  outboxDispatcher.start()

  const usecases = {
    addItem: makeAddItemUsecase({ orderRepository }),
    openOrder: makeOpenOrderUsecase({ orderRepository }),
    closeOrder: makeCloseOrderUsecase({ orderRepository }),
    login: makeLoginUsecase({ userRepository }),
  }

  return { db, wsGateway, usecases }
}
```

Montado uma única vez, na inicialização (`server.ts`). Rotas HTTP chamam apenas `container.usecases.X` — nenhuma rota ou usecase instancia repositório diretamente. Isso também viabiliza testes de unidade sem banco real, injetando um repositório fake que satisfaz a interface.

## 7. API REST

### 7.0 Convenções gerais

- **Base**: todas as rotas abaixo de `/`, prefixadas por nada nesta etapa (sem versionamento de API ainda — se necessário no futuro, `/v1`).
- **Auth**: header `Authorization: Bearer <jwt>` obrigatório em toda rota, exceto `POST /auth/login`. Token obtido no login, reaproveitado no WebSocket (seção 8).
- **Content-Type**: `application/json` em todo corpo de requisição/resposta.
- **Envelope de erro padrão**:
  ```typescript
  { error: { code: string, message: string, details?: unknown } }
  ```
- **Mapeamento de status HTTP**:

  | Status | Quando |
  |---|---|
  | 200 / 201 | sucesso (200 leitura/atualização, 201 criação) |
  | 204 | sucesso sem corpo (ex: `DELETE`) |
  | 400 | validação de payload (schema Zod falhou) |
  | 401 | token ausente/inválido/expirado, ou PIN incorreto no login |
  | 403 | autenticado, mas sem role permitida pra rota |
  | 404 | recurso não encontrado |
  | 409 | conflito de estado — lock otimista (`version` divergente), comanda com item pendente ao tentar fechar, ou order já fechada |
  | 429 | rate limit (ex: `/auth/login`, seção 11) |

- **Paginação**: rotas de listagem (`GET /orders`, `GET /products`, `GET /categories`, `GET /users`) aceitam `?limit=` (padrão 50, máx 200) e `?offset=` (padrão 0). Resposta no formato `{ data: T[], total: number }`. Listas pequenas por natureza nesta etapa (ex: `GET /categories`) não precisam paginar de fato, mas mantêm o mesmo envelope por consistência.
- **Idempotência**: rotas que a exigem (seção 10) recebem `correlationId` no corpo, não em query string ou header.
- **Health check**: `GET /health` é a única rota sem autenticação além do login — ver seção 14.4.

### 7.1 Autenticação

```
POST /auth/login
```
- Body: `{ userId: string, pin: string }`
- 200: `{ token: string, user: { id, name, role } }`
- 401 `invalid_credentials`: PIN incorreto **ou** conta bloqueada — mesma mensagem genérica nos dois casos, de propósito (seção 11, não vazar motivo do bloqueio)
- 429 `too_many_attempts`: rate limit por IP (10/min), independente do bloqueio por conta

### 7.2 Comandas (orders)

```
POST   /orders
```
- Requer role: `waiter` ou `manager`
- Body: `{ correlationId: string, tableId?: string, customerId?: string, tabLabel?: string }` — ao menos um dos três identificadores
- 201: order criada (status `open`)
- 400 `identification_required`: nenhum dos três identificadores foi enviado

```
POST   /orders/:id/items
```
- Requer role: `waiter` ou `manager`
- Body: `{ correlationId: string, items: [{ productId, quantity, selectedVariations?, notes? }] }` — lote (revisão já feita no client antes de confirmar, seção 4.4 do frontend spec)
- 201: `{ data: OrderItem[] }` — os itens criados, na mesma ordem enviada
- 400: item com `productId` inativo ou inexistente
- 409 `order_not_open`: comanda já fechada

```
PATCH  /orders/:id/items/:itemId
```
- Requer role: `kitchen` ou `manager` (pra `ready`, só quando `kitchen_enabled = true`), `waiter` ou `manager` (pra `delivered`)
- Body: `{ status: "ready" | "delivered", expectedVersion: number }`
- 200: item atualizado
- 409 `concurrency_conflict`: `version` divergente — outra pessoa já mudou o item; client deve refazer o fetch (seção 9)
- 400 `invalid_transition`: transição depende de `store_settings.kitchen_enabled`:
  - **`kitchen_enabled = true`**: `ordered → ready` (cozinha) e `ready → delivered` (garçom) são as únicas válidas; pular direto de `ordered` pra `delivered` é `invalid_transition`
  - **`kitchen_enabled = false`**: não existe estação de cozinha pra marcar `ready` — a única transição válida é `ordered → delivered`, feita pelo garçom; tentar setar `ready` nesse modo também é `invalid_transition`
  - Em ambos os modos, voltar de `delivered` pra qualquer status anterior é `invalid_transition`

```
DELETE /orders/:id/items/:itemId
```
- Requer role: `waiter` ou `manager`
- 204, sem corpo
- 409 `item_already_delivered`: item já está `delivered` — é conflito de estado, não de permissão (por isso 409, não 403, seguindo a convenção da seção 7.0)

```
PATCH  /orders/:id/payment
```
- Requer role: `waiter` ou `manager`
- Body: `{ paymentMethod: "cash" | "card" | "pix" | "other", confirmed: boolean }` — `confirmed=true` grava `payment_confirmed_at`/`payment_confirmed_by`; permite registrar o método antes de confirmar (fluxo Pix: registra método, gera QR, só confirma depois que o cliente paga)
- **Endpoint legado**: descreve a intenção em **uma única linha de 100% do total** em `order_payment` (`confirmed=false` nasce como intenção de Pix; `confirmed=true` confirma). Mantido como adaptador para o checkout self-service e o delivery (§04) — clientes novos devem usar o PUT fracionado abaixo
- 200: linha de `order_payment` criada/atualizada
- 400 `payment_method_disabled`: método não está em `store_settings.enabled_payment_methods`
- 409 `order_not_open`: comanda já fechada/cancelada

```
PUT    /orders/:id/payments
```
- Requer role: `waiter` ou `manager`
- Body: `{ payments: [{ method, amount, received?, confirmed? }] }` — `received` só vale para `cash` (quanto o cliente entregou; o troco é derivado `received - amount`); `confirmed` é opcional e fica `false` por padrão (Pix deixa para confirmar depois de escaneado o QR)
- Substitui o conjunto inteiro de linhas em `order_payment` na mesma transação (atómico). Regras:
  - a soma dos `amount` deve bater com o total da comanda (snapshot `unit_price × quantity`, excluídos `cancelled`, + `delivery_fee`)
  - `cash` com `confirmed=true` exige `received >= amount`
  - métodos precisam estar em `store_settings.enabled_payment_methods`
- 200: comanda atualizada (`payments[]` no corpo — mesmo shape do `GET /orders/:id`)
- 409 `invalid_payment_total`: soma dos pedaços divergente do total
- 422 `validation_failed`: `received < amount` em dinheiro confirmado
- 409 `payment_not_confirmed`: ao tentar fechar com pedaço Pix pendente

```
PATCH  /orders/:id/payments/:paymentId
```
- Requer role: `waiter` ou `manager`
- Confirma uma linha (`confirmed=true`, grava `confirmed_at`/`confirmed_by`) — usado no fluxo Pix por pedaço
- 200: linha `order_payment` atualizada
- 404 `not_found`: linha inexistente ou de outra comanda
- 409 `order_not_open`: comanda já fechada

```
DELETE /orders/:id/payments/:paymentId
```
- Requer role: `waiter` ou `manager`
- Remove uma linha **não confirmada** (editar a forma de pagamento antes de fechar)
- 204, sem corpo
- 400 `invalid_transition`: linha já confirmada não pode ser removida

```
PATCH  /orders/:id/close
```
- Body: `{ correlationId: string }`
- 200: order fechada (`status: closed`, `closed_at` preenchido)
- 409 `pending_items`: existe item que não é `delivered`/`cancelled` — resposta inclui `details: { pendingItems: [{ id, name, quantity, status }] }`, pra UI listar exatamente o que falta (hoje o frontend só mostra a contagem — ver observação abaixo)
- 409 `payment_not_registered`: comanda sem **nenhuma** linha em `order_payment`
- 409 `payment_not_confirmed`: existe linha `order_payment` com `confirmed=false` (ex.: Pix ainda não conferido no extrato)
- 409 `invalid_payment_total`: soma das linhas diverge do total (divisão mal ajustada)

**Nota de design (fechamento):** o `payment_method` de `order` é denormalizado só para exibição e histórico de comandas antigas. A fonte da verdade do pagamento é `order_payment`: o fechamento exige **ao menos uma linha**, **todas confirmadas** e **soma == total** — os três erros acima são o espelho disso. Comandas legadas (pré-`order_payment`) fecham sem linhas apenas em sentido de leitura: o relatório (§7.9) as atribui pelo `payment_method` denormalizado pra não sumirem do histórico.

```
GET    /orders/:id          → detalhe com itens
GET    /orders?status=open&limit=&offset=  → lista de comandas (mapa/lista do garçom e gerente)
GET    /tables               → lista mesas com status
```

### 7.3 Configuração da loja

```
GET    /store-settings
PUT    /store-settings       → requer role: manager
```
- Body do `PUT`: `{ merchantName, merchantCity, pixKey, pixKeyType, usesTables, kitchenEnabled, enabledPaymentMethods, kitchenPrepWarnMin, kitchenPrepUrgentMin, kitchenPickupUrgentMin, inventoryEnabled }`
- 200: configuração atualizada
- 400: `merchantName` acima de 25 caracteres ou `merchantCity` acima de 15 — limites do padrão BR Code (seção 12)
- 400 `invalid_kitchen_thresholds`: `kitchenPrepUrgentMin <= kitchenPrepWarnMin` — o limiar vermelho precisa ser maior que o âmbar, senão a escala de urgência não faz sentido

### 7.4 Log de auditoria

```
GET    /audit-log?order_id=&limit=&offset=
```
- Filtro por comanda opcional; sem filtro, retorna o log geral (útil pra conferência de turno do gerente)

### 7.5 Produtos (requer role: manager)

```
GET    /products?category_id=&active=&limit=&offset=
POST   /products
PATCH  /products/:id
PATCH  /products/:id/deactivate   → desativa (não deleta, preserva histórico)
PATCH  /products/:id/activate     → reativa um produto desativado
```
- Body do `POST`/`PATCH`: `{ categoryId, name, price, variations?, costPrice?, lowStockThreshold?, trackStock? }` — campos de estoque obrigatórios só no `POST` quando `trackStock=true` (`costPrice`/`lowStockThreshold`/`trackStock`, padrões 0/0/false); `POST` também aceita `initialStock?` (cria movimento `adjustment` de saldo inicial na mesma transação)
- `POST /products` com `trackStock=true` e `initialStock` informado gira um movimento `adjustment` na mesma transação do create — o estoque inicial já nasce no ledger, não numa coluna solta
- 400: `price < 0`, `costPrice < 0`, `lowStockThreshold < 0`, `initialStock < 0`
- `GET /products` (todas as telas) devolve também `costPrice`, `lowStockThreshold`, `trackStock`, `quantity` e `low` — o client usa `trackStock`/`quantity` pra desabilitar item sem estoque na tela de lançamento; o gerenciamento de estoque em si fica em `GET /stock` (ver `07-estoque.md`)
- **Nota de design**: produto nunca é hard-deleted (só desativado) porque `order_item.product_id` referencia `product(id) ON DELETE RESTRICT` — um produto já usado em qualquer comanda não pode ser removido do banco sem quebrar o histórico. Isso é diferente de categoria (seção 7.6), que pode ser excluída de verdade porque `product.category_id` aceita nulo. Essa assimetria é intencional, não uma inconsistência a resolver.

### 7.6 Categorias (requer role: manager)

```
GET    /categories
POST   /categories
PATCH  /categories/:id            → renomeia e/ou reordena via display_order
DELETE /categories/:id            → exclui; produtos vinculados ficam com category_id nulo até reatribuição
```

### 7.7 Usuários (requer role: manager)

```
GET    /users
POST   /users
PATCH  /users/:id                 → nome, role, active (desativação é um PATCH normal, não uma rota própria)
PATCH  /users/:id/reset-pin       → gera novo PIN, retorna uma única vez em texto puro pra exibição ao gerente
```
- 400 no `POST`/`PATCH`: `pin` nunca aceito nesses corpos — definição de PIN só acontece via `reset-pin`, nunca junto com outros campos, pra evitar path de auditoria confuso sobre quando um PIN mudou

### 7.8 Clientes

```
GET    /customers?search=         → busca por nome/telefone (autocomplete na abertura de comanda)
POST   /customers
```
- Sem restrição de role — qualquer perfil autenticado pode buscar/cadastrar cliente durante o atendimento
- 201 no `POST`: cliente criado; sem endpoint de edição nesta etapa (fora do escopo — ver `01-backend-spec.md`, seção 1)

### 7.9 Relatório de vendas (requer role: manager)

```
GET /reports/sales?dateFrom=&dateTo=&customerQuery=&productId=&limit=&offset=
```
- Todos os filtros são opcionais; sem nenhum, retorna as comandas fechadas dos últimos 30 dias (mesmo padrão do frontend, seção 5)
- `dateFrom`/`dateTo`: `YYYY-MM-DD`, filtram por `order.closed_at`
- `customerQuery`: busca parcial (case-insensitive) em `table.number`, `customer.name` ou `order.tab_label` — o que estiver preenchido na comanda
- `productId`: retorna só comandas que contêm ao menos um item desse produto
- 200:
  ```typescript
  {
    data: Array<{ orderId, label, closedAt, paymentMethod, total }>,
    total: number, // contagem de comandas, não confundir com soma de valores
    summary: {
      totalRevenue: number,
      orderCount: number,
      avgTicket: number,
      byPaymentMethod: Record<"cash" | "card" | "pix" | "other", number>,
      changeTotal: number // troco dado em dinheiro no período (soma de order_payment.change)
      byProduct: Array<{ productId, name, quantity, revenue, cost, profit }> // margem por produto (snapshots)
    }
  }
  ```
- `total` de cada comanda é calculado a partir de `order_item.unit_price × quantity` (o snapshot gravado no lançamento, não o preço atual do produto — seção 4) somado por comanda; `summary` é agregado sobre o mesmo conjunto filtrado, não sobre a página retornada (senão paginar mudaria o total, o que quebraria a confiança no relatório)
- `data[].paymentMethod` é o rótulo derivado das `order_payment` da comanda ("cash + pix"), não o denormalizado — como a comanda pode ter várias formas, o denormalizado de exibição não é suficiente (seção 7.2)
- `byPaymentMethod` soma os **pedaços** de `order_payment` (cada forma com seu valor). Comandas antigas sem linhas (pré-`order_payment`) atribuem o total ao `payment_method` denormalizado — assim o histórico não perde a forma de pagamento original
- `byProduct` agrega por produto sobre o mesmo conjunto filtrado: `revenue` é a soma de `unit_price × quantity` (snapshot do lançamento), `cost` a soma de `order_item.cost_price × quantity` (snapshot do custo) e `profit = revenue − cost`. Sem `cost_price` cadastrado o custo é 0 — o client indica "sem custo cadastrado" em vez de inferir margem
- Sem paginação por padrão nesta etapa (volume esperado é baixo — seção 15); os parâmetros `limit`/`offset` existem só por consistência com as outras listagens, caso o volume cresça

### 7.10 Exemplos de payload

Convenção: API sempre em `camelCase`, mapeado para `snake_case` do schema (seção 4) na camada de repositório — o Drizzle já lida com esse mapeamento via `casing: "snake_case"` na config do client, então o código de aplicação nunca escreve `snake_case` manualmente.

**`POST /auth/login`**
```json
// Request
{ "userId": "u_ana", "pin": "1234" }

// 200
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": "u_ana", "name": "Ana Ribeiro", "role": "waiter" }
}

// 401
{ "error": { "code": "invalid_credentials", "message": "PIN incorreto." } }
```

**`POST /orders`** — abrindo comanda no modo mesa
```json
// Request
{ "correlationId": "c_8f2a1", "tableId": "t_03" }

// 201
{
  "id": "o_7d21",
  "status": "open",
  "tableId": "t_03",
  "customerId": null,
  "tabLabel": null,
  "waiterId": "u_ana",
  "paymentMethod": null,
  "openedAt": "2026-08-02T14:03:11.000Z",
  "items": []
}
```

**`POST /orders/:id/items`** — confirmação em lote (seção 4.4 do frontend spec)
```json
// Request
{
  "correlationId": "c_9a01e",
  "items": [
    { "productId": "p_xburger", "quantity": 2, "selectedVariations": { "ponto": "Ao ponto" } },
    { "productId": "p_batata", "quantity": 1 }
  ]
}

// 201
{
  "data": [
    { "id": "oi_001", "productId": "p_xburger", "name": "X-Burger", "quantity": 2, "unitPrice": 28.0, "status": "ordered", "version": 1 },
    { "id": "oi_002", "productId": "p_batata", "name": "Batata frita", "quantity": 1, "unitPrice": 18.0, "status": "ordered", "version": 1 }
  ]
}
```

**`PATCH /orders/:id/items/:itemId`** — conflito de concorrência (seção 9)
```json
// Request
{ "status": "delivered", "expectedVersion": 1 }

// 409 (outro usuário já mudou o item — version atual no banco é 2)
{
  "error": {
    "code": "concurrency_conflict",
    "message": "Este item foi alterado por outra pessoa. Recarregue e tente novamente.",
    "details": { "currentVersion": 2 }
  }
}
```

**`PATCH /orders/:id/close`** — bloqueado por item pendente (seção 4.5 do frontend spec)
```json
// 409
{
  "error": {
    "code": "pending_items",
    "message": "Ainda há itens não entregues nesta comanda.",
    "details": {
      "pendingItems": [
        { "id": "oi_001", "name": "X-Burger", "quantity": 2, "status": "ready" }
      ]
    }
  }
}
```

**`PATCH /orders/:id/payment`** (legado — ver §7.2)
```json
// Request — registra o método sem confirmar ainda (caso Pix: QR já pode ser gerado no client com esses dados)
{ "paymentMethod": "pix", "confirmed": false }

// 200
{
  "id": "op_1", "method": "pix", "amount": 74.0,
  "received": null, "change": null, "confirmed": false
}
```

**`PUT /orders/:id/payments`** — pagamento fracionado
```json
// Request — dinheiro R$ 40 (recebido R$ 100, troco R$ 60) + pix R$ 34
{
  "payments": [
    { "method": "cash", "amount": 40, "received": 100, "confirmed": true },
    { "method": "pix", "amount": 34, "confirmed": false }
  ]
}

// 200
{
  "id": "o_7d21",
  "status": "open",
  "paymentMethod": null,
  "payments": [
    { "id": "op_1", "method": "cash", "amount": 40, "received": 100, "change": 60, "confirmed": true, "confirmedAt": "2026-08-02T20:10:00.000Z", "confirmedBy": "u_ana" },
    { "id": "op_2", "method": "pix", "amount": 34, "received": null, "change": null, "confirmed": false, "confirmedAt": null, "confirmedBy": null }
  ]
}
```

**`PATCH /orders/:id/payments/:paymentId`** — confirma o pedaço Pix após conferir o extrato
```json
// 200
{ "id": "op_2", "method": "pix", "amount": 34, "confirmed": true, "confirmedAt": "2026-08-02T20:15:00.000Z", "confirmedBy": "u_ana" }
```

**`PUT /store-settings`**
```json
// Request
{
  "merchantName": "BAR DO ZE",
  "merchantCity": "SAO LEOPOLDO",
  "pixKey": "11999998888",
  "pixKeyType": "phone",
  "usesTables": true,
  "kitchenEnabled": true,
  "enabledPaymentMethods": ["cash", "card", "pix"],
  "kitchenPrepWarnMin": 3,
  "kitchenPrepUrgentMin": 6,
  "kitchenPickupUrgentMin": 5
}

// 400 — nome acima do limite do padrão BR Code
{ "error": { "code": "validation_failed", "message": "merchantName deve ter no máximo 25 caracteres." } }
```

### 7.11 Tabela de erros consolidada

Referência única de todo `error.code` que a API pode devolver — útil pro frontend mapear mensagem amigável por código, em vez de exibir `error.message` cru (que é só um fallback de debug, não texto pra usuário final).

| Código | Status | Onde ocorre | Significado |
|---|---|---|---|
| `validation_failed` | 400 | qualquer rota com body | payload não passou no schema Zod |
| `identification_required` | 400 | `POST /orders` | nenhum de `tableId`/`customerId`/`tabLabel` enviado |
| `payment_method_disabled` | 400 | `PATCH /orders/:id/payment` | método fora de `store_settings.enabled_payment_methods` |
| `invalid_kitchen_thresholds` | 400 | `PUT /store-settings` | `kitchenPrepUrgentMin` menor ou igual a `kitchenPrepWarnMin` |
| `invalid_transition` | 400 | `PATCH /orders/:id/items/:itemId` | mudança de status não permitida (ex: `delivered` → `ordered`) |
| `pin_not_allowed_here` | 400 | `POST/PATCH /users` | tentativa de definir PIN fora de `reset-pin` |
| `unauthorized` | 401 | qualquer rota | token ausente, inválido ou expirado |
| `invalid_credentials` | 401 | `POST /auth/login` | PIN incorreto **ou** conta bloqueada — mensagem genérica de propósito (seção 11) |
| `forbidden_role` | 403 | qualquer rota com restrição de role | usuário autenticado, mas sem permissão pra essa ação |
| `not_found` | 404 | qualquer rota com `:id` | recurso inexistente |
| `order_not_open` | 409 | `POST /orders/:id/items` | tentativa de lançar item em comanda já fechada |
| `item_already_delivered` | 409 | `DELETE /orders/:id/items/:itemId` | item já `delivered` não pode ser removido |
| `concurrency_conflict` | 409 | `PATCH /orders/:id/items/:itemId` | `expectedVersion` divergente do `version` atual (seção 9) |
| `pending_items` | 409 | `PATCH /orders/:id/close` | existe item não `delivered`/`cancelled`; `details.pendingItems` traz a lista |
| `payment_not_registered` | 409 | `PATCH /orders/:id/close` | comanda sem nenhuma linha em `order_payment` |
| `payment_not_confirmed` | 409 | `PATCH /orders/:id/close` | existe linha `order_payment` com `confirmed=false` (ex.: Pix a conferir) |
| `invalid_payment_total` | 409 | `PUT /orders/:id/payments`, `PATCH /orders/:id/close` | soma de `order_payment.amount` diverge do total da comanda |
| `insufficient_stock` | 409 | `POST /orders/:id/items` | produto com `track_stock` e módulo ligado sem saldo suficiente; `details`: `{ productId, name, available }` |
| `too_many_attempts` | 429 | `POST /auth/login` | rate limit por IP (seção 11) |

Todo erro 4xx segue o mesmo envelope da seção 7.0 — o `code` acima é sempre o campo estável pra lógica de UI; `message` pode mudar de texto sem quebrar o client.

## 8. WebSocket

Conexão: `ws://<host>:3000/realtime`, token JWT no handshake (mesmo token do REST).

**Envelope de evento:**

```typescript
interface WsEvent<T = unknown> {
  type: string
  payload: T
  emittedAt: string
  correlationId?: string
}
```

**Eventos (server → client):**

```typescript
{ type: "order.item.created", payload: { orderId, item } }
{ type: "order.item.status_changed", payload: { orderId, itemId, status, changedBy } }
{ type: "table.status_changed", payload: { tableId, status } }
{ type: "order.closed", payload: { orderId, tableId } }
```

**Rooms:** clientes entram em canais lógicos (`kitchen-display`, `waiter:{userId}`, `table:{tableId}`) para receber apenas eventos relevantes.

**Reconexão/catch-up:**

```typescript
// cliente → servidor, ao reconectar
{ type: "sync.request", payload: { since: "<timestamp>", tableId: "..." } }
// servidor → cliente, delta de eventos perdidos
{ type: "sync.response", payload: { events: WsEvent[] } }
```

**Outbox pattern:** eventos WS não são disparados diretamente no handler HTTP. A intenção de emitir é gravada na mesma transação que persiste o dado (`outbox_event`), e um dispatcher em background (polling ~200ms ou `LISTEN/NOTIFY`) varre registros `published = false`, emite via WebSocket, e marca como publicados. Isso garante entrega mesmo que o processo caia entre o commit e o broadcast.

## 9. Controle de Concorrência

**Lock otimista por item** (não por order inteira), via campo `version`:

```typescript
async function updateItemStatus(itemId: string, newStatus: string, expectedVersion: number) {
  const result = await db.update(orderItem)
    .set({ status: newStatus, version: sql`version + 1`, updatedAt: new Date() })
    .where(and(eq(orderItem.id, itemId), eq(orderItem.version, expectedVersion)))
    .returning()

  if (result.length === 0) throw new ConcurrencyConflictError(itemId)
  return result[0]
}
```

Cliente sempre envia a `version` que tinha em tela. Conflito (0 rows afetadas) → frontend refaz fetch e informa que o item foi alterado por outra pessoa, sem sobrescrever.

**Fechamento de order** usa lock transacional curto (`FOR UPDATE`), pois exige checar estado agregado (nenhum item pendente sem ser `delivered`/`cancelled`):

```typescript
async function closeOrder(orderId: string) {
  return db.transaction(async (tx) => {
    const order = await tx.select().from(orders)
      .where(eq(orders.id, orderId)).for('update').then(r => r[0])

    if (order.status !== 'open') throw new InvalidStateError()

    const pending = await tx.select().from(orderItem)
      .where(and(eq(orderItem.orderId, orderId), notInArray(orderItem.status, ['delivered', 'cancelled'])))

    if (pending.length > 0) throw new PendingItemsError(pending)
    if (!order.paymentMethod) throw new PaymentNotRegisteredError(orderId)

    return tx.update(orders).set({ status: 'closed', closedAt: new Date() }).where(eq(orders.id, orderId))
  })
}
```

`PendingItemsError` carrega a lista de itens pendentes (`id`, `name`, `quantity`, `status`) no corpo da resposta 409, não só a contagem — permite à UI mostrar exatamente o que falta em vez de uma mensagem genérica (ver `01-backend-spec.md`, seção 7.2). `PaymentNotRegisteredError` garante que a comanda não feche sem forma de pagamento definida via `PATCH /orders/:id/payment`, mesmo que todos os itens já estejam entregues.

## 10. Idempotência

Chave de idempotência (`correlationId`, UUID) é gerada **no cliente**, uma vez por ação do usuário, e reenviada em caso de retry por timeout de rede.

**Fluxo (middleware):**

1. Cliente envia `correlationId` no corpo da requisição.
2. Servidor verifica `idempotency_key`:
   - Não existe → grava como `processing` **na mesma transação** do usecase, processa, marca `completed` ao final.
   - Existe e `completed` → devolve resposta cacheada, não reprocessa (e não republica evento WS — ver seção 8).
   - Existe e `processing` → requisição concorrente idêntica em voo, cliente trata como "aguarde".
   - Existe com `requestHash` diferente → erro de uso indevido.
3. `expires_at` curto (15 min) — escape hatch caso o processo caia entre gravar `processing` e completar.

**Escopo de aplicação:** obrigatório em `POST /orders`, `POST /orders/:id/items`, `PATCH /orders/:id/close`. Opcional (mas recomendado) em `PATCH .../items/:itemId`, já que o lock otimista por `version` já cobre parte do risco.

## 11. Autenticação (PIN)

PIN numérico (4-6 dígitos), armazenado com `argon2` (nunca texto puro), mesmo sendo curto — protege contra vazamento de banco.

```typescript
async function login(userId: string, rawPin: string) {
  const u = await db.select().from(user).where(eq(user.id, userId)).then(r => r[0])
  if (!u || !u.active) throw new InvalidCredentialsError()
  if (u.lockedUntil && u.lockedUntil > new Date()) throw new AccountLockedError(u.lockedUntil)

  const valid = await argon2.verify(u.pinHash, rawPin)
  if (!valid) {
    const attempts = u.failedAttempts + 1
    const shouldLock = attempts >= 5
    await db.update(user).set({
      failedAttempts: attempts,
      lockedUntil: shouldLock ? new Date(Date.now() + 5 * 60_000) : null
    }).where(eq(user.id, userId))
    throw new InvalidCredentialsError()
  }

  await db.update(user).set({ failedAttempts: 0, lockedUntil: null }).where(eq(user.id, userId))
  const token = signJwt({ sub: u.id, role: u.role }, { expiresIn: '12h' })
  return { token, user: { id: u.id, name: u.name, role: u.role } }
}
```

- **Rate limiting** adicional por IP na rota `/auth/login` (10 tentativas/min), independente de conta bloqueada individualmente.
- **JWT payload mínimo**: `{ sub, role, iat, exp }`, expiração de 12h (turno de trabalho). Sem dados mutáveis (ex: `name`) no token.
- **Token reaproveitado no WebSocket** — sem fluxo de auth separado.
- **Troca de usuário** no tablet compartilhado descarta o token localmente (client-side), forçando novo PIN; o token antigo permanece tecnicamente válido até expirar (trade-off aceito nesta escala).
- **Autorização por rota** via middleware `requireRole(...roles)`, ex: cancelamento de item exige `role: manager`.

## 12. Pagamento via Pix Estático

### O que é gerado

Um **BR Code** (payload EMV QR Code, padrão do Banco Central para Pix), contendo a chave Pix do estabelecimento, o valor da comanda, e um identificador de transação. Não existe chamada a API de banco ou de PSP — o payload é montado e o QR renderizado inteiramente a partir de dados que já estão no sistema (`store_settings` + total da order). Isso pode ser feito no **frontend**, sem round-trip ao backend, já que não há segredo envolvido (a chave Pix é pública por natureza — é o que o cliente usa pra pagar).

### Estrutura do payload (simplificada)

O BR Code é uma string de campos `ID + tamanho + valor`, concatenados, com um CRC16 ao final para integridade:

```
00 - Payload Format Indicator          → "01"
26 - Merchant Account Info (Pix)
     00 - GUI                          → "br.gov.bcb.pix"
     01 - Chave Pix                    → store_settings.pix_key
     02 - Descrição (opcional)         → ex: "Mesa 3"
52 - Merchant Category Code            → "0000"
53 - Moeda                             → "986" (BRL)
54 - Valor da transação                → total da order, ex: "64.00"
58 - País                              → "BR"
59 - Nome do recebedor                 → store_settings.merchant_name (máx 25 char)
60 - Cidade do recebedor               → store_settings.merchant_city (máx 15 char)
62 - Additional Data (txid)
     05 - Transaction ID               → order.id (truncado/formatado conforme spec)
63 - CRC16                             → checksum calculado sobre tudo acima
```

### Implementação

```typescript
// Sem dependência de backend — função pura, roda no client
function buildPixPayload(params: {
  pixKey: string
  merchantName: string
  merchantCity: string
  amount: number
  txid: string
  description?: string
}): string {
  const field = (id: string, value: string) =>
    `${id}${String(value.length).padStart(2, "0")}${value}`

  const merchantAccountInfo = field("00", "br.gov.bcb.pix")
    + field("01", params.pixKey)
    + (params.description ? field("02", params.description.slice(0, 40)) : "")

  const additionalData = field("05", params.txid.slice(0, 25))

  const payloadWithoutCRC =
    field("00", "01") +
    field("26", merchantAccountInfo) +
    field("52", "0000") +
    field("53", "986") +
    field("54", params.amount.toFixed(2)) +
    field("58", "BR") +
    field("59", params.merchantName.slice(0, 25)) +
    field("60", params.merchantCity.slice(0, 15)) +
    field("62", additionalData) +
    "6304" // CRC16 id + tamanho fixo, valor calculado a seguir

  return payloadWithoutCRC + crc16(payloadWithoutCRC)
}
```

`crc16` implementa CRC-16/CCITT-FALSE sobre a string do payload — é um algoritmo padrão, disponível em qualquer biblioteca de Pix BR Code (ex: `pix-utils` no npm) ou implementável em poucas linhas.

O QR em si é só essa string renderizada como imagem (biblioteca `qrcode` no frontend).

### Fluxo de uso

```
Fechar comanda → gerente/garçom monta o pagamento (seção 4.5 do frontend spec)
  ├── Método único (dinheiro/cartão/outro) → registra com confirmed=true → fecha
  ├── Várias formas (dinheiro + cartão + pix…) → PUT /orders/:id/payments com uma linha por pedaço
  │     └── Pix fica confirmed=false; dinheiro confirma no registro (com troco se received > amount)
  └── Pedaço Pix
        → gera BR Code com o valor daquele pedaço (não o total da comanda)
        → exibe QR na tela (cliente escaneia com o app do banco)
        → gerente confere manualmente no extrato/notificação do banco
        → PATCH /orders/:id/payments/:paymentId → confirma o pedaço → fecha a order
```

Quando há mais de um pedaço Pix, o client exibe um QR por pedaço e confirma um a um; o fechamento só acontece depois que **todos** os pedaços estão `confirmed=true` (§7.2).

### Configuração necessária

Tela de gerente precisa de uma seção de **configuração da loja** (`store_settings`), preenchida uma vez: nome do estabelecimento (até 25 caracteres — limite do padrão), cidade (até 15 caracteres), chave Pix e seu tipo. Sem isso, o botão de gerar Pix fica desabilitado com aviso pra configurar antes.

A mesma tabela guarda dois outros parâmetros configuráveis pelo gerente:

- **`uses_tables`**: quando `false`, a abertura de comanda não oferece a opção "Mesa" — o garçom vai direto para identificação por cliente/rótulo livre. Pensado para estabelecimentos tipo pub que não organizam o salão por número de mesa.
- **`enabled_payment_methods`**: lista de formas de pagamento que aparecem no fechamento de conta. Permite ao gerente desligar uma forma que o estabelecimento não aceita (ex: só dinheiro e Pix, sem cartão) sem precisar de deploy.

### Endpoints

```
GET    /store-settings
PUT    /store-settings              → requer role: manager
PATCH  /orders/:id/payment          → legado (registra intenção única em order_payment — §7.2; requer role: waiter ou manager)
PUT    /orders/:id/payments         → define o conjunto de pedaços de pagamento (requer role: waiter ou manager)
PATCH  /orders/:id/payments/:paymentId  → confirma um pedaço (requer role: waiter ou manager)
```

## 13. Log de Auditoria

Toda ação relevante do garçom ou gerente é registrada em `audit_log`, de forma assíncrona em relação à operação principal (não bloqueia a resposta ao usuário — grava e segue).

**Ações registradas:** abertura de comanda, item adicionado (por lote, um registro por linha do lote confirmado), item removido, item marcado como entregue, pagamento registrado/confirmado/removido (`payment_registered`, `payment_confirmed`, `payment_removed`), comanda fechada (com o detalhe dos pedaços de pagamento), movimento de estoque manual (`stock_movement_manual`). Venda/estorno de estoque não têm linha própria de auditoria — o próprio `stock_movement` (com `order_id`/`order_item_id`) é o registro auditável.

```typescript
async function logAction(userId: string, action: string, orderId: string | null, details: object) {
  await db.insert(auditLog).values({ userId, action, orderId, details })
}
```

Cada usecase relevante chama `logAction` após a operação principal ter sucesso — mesmo padrão de "só loga o que de fato aconteceu" usado no outbox de eventos WebSocket (seção 8). O log é consultável por comanda (`GET /audit-log?order_id=`) para conferência — por exemplo, um gerente investigando por que um item sumiu de uma comanda.

## 14. Deployment e Setup

### 14.1 Modo local

> **Atualização 2026 (decidido)**: a contradição apontada nesta seção foi
> **resolvida em favor do Postgres também no modo local** — o SQLite foi
> removido do produto. O compose local sobe `backend` + `postgres` + `frontend`
> (o `postgres` é o serviço de banco do modo local, com healthcheck; o backend
> só sobe depois dele ficar pronto).

```
docker-compose.local.yml (modo local)
├── postgres    (Postgres 16, volume pdv_postgres_data — dados persistentes)
├── backend     (Node, porta 3000, sem porta exposta — só o Caddy fala com ele)
└── frontend
```

Modo cloud: mesma imagem `app`, sem `docker-compose.yml` nenhum necessariamente (pode ser qualquer runtime que suporte um container Node — Fly.io, Railway, ECS etc.) — `DATABASE_URL` aponta para a instância Postgres gerenciada (RDS/Supabase), sem volume de dados local, já que o estado vive no Postgres.

### 14.2 Variáveis de ambiente

| Variável | Obrigatória | Exemplo (local) | Exemplo (cloud) |
|---|---|---|---|
| `DEPLOYMENT_MODE` | sim | `local` | `cloud` |
| `DATABASE_URL` | sim | `postgres://pdv:senha@postgres:5432/pdv` | `postgres://user:pass@host:5432/pdv` |
| `JWT_SECRET` | sim | gerado uma vez no primeiro setup, salvo no `.env` do servidor local | secret gerenciado (ex: variável de ambiente do provedor) |
| `DATABASE_POOL_MAX` | não (padrão `10`) | `10` | conforme a instância |
| ~~`SYNC_ENABLED`~~ | — | **removida** (o SQLite foi removido; o backup é `deploy/backup.sh` com `pg_dump`) | — |
| ~~`SYNC_TARGET_URL`~~ | — | **removida** com o SQLite | — |
| `PORT` | não (padrão `3000`) | `3000` | definido pelo provedor cloud, geralmente via `PORT` injetada |
| `LOG_LEVEL` | não (padrão `info`) | `debug` em desenvolvimento | `info` ou `warn` em produção |

Um arquivo `.env.example` com essas chaves (sem valores reais) deve acompanhar o repositório — hoje não existe, é o primeiro artefato que falta pra alguém clonar o repo e rodar localmente sem precisar perguntar nada.

### 14.3 Seed de dados

Sem dados iniciais, ninguém consegue logar (login é por PIN de um `user` já cadastrado — não existe fluxo de "criar minha própria conta"). O projeto precisa de um script de seed (`npm run seed`, ou rodado automaticamente no primeiro start em modo local) que cria:

- 1 usuário `manager` com PIN conhecido (só em ambiente de desenvolvimento — nunca em produção com PIN previsível)
- 2-3 categorias e produtos de exemplo, pra ter algo navegável na tela do garçom sem precisar cadastrar tudo manualmente antes de testar
- `store_settings` com valores padrão (`uses_tables: true`, `enabled_payment_methods` com todas habilitadas, dados de Pix em branco)
- Opcionalmente, 3-4 mesas (`restaurant_table`) numeradas, já que sem isso a tela de abertura de comanda no modo Mesa fica vazia

Em produção (primeiro deploy real num estabelecimento), o seed deve ser mínimo: só o usuário `manager` inicial, pra ele entrar e cadastrar o resto pela própria UI — nunca dados fictícios de restaurante indo pra produção.

### 14.4 Health check

Endpoint necessário pro `healthcheck` do Docker Compose e pra qualquer monitoramento externo (uptime check em modo cloud):

```
GET /health
```
- Sem autenticação
- 200: `{ status: "ok", database: "connected" }` — faz um `SELECT 1` simples pra confirmar que o banco está acessível, não só que o processo Node está de pé
- 503: `{ status: "degraded", database: "disconnected" }` — se o banco não responder

### 14.5 Migrations

Mudança de schema (seção 4) depois do primeiro deploy usa as migrations geradas pelo Drizzle Kit (`drizzle-kit generate`), versionadas no repositório (`/migrations`, um arquivo `.sql` por mudança, nunca editado depois de commitado). Aplicação das migrations:

- **Modo local**: roda automaticamente no boot do container `app` (antes do servidor HTTP subir), já que não há como alguém rodar um comando manual num mini-PC dentro de um bar
- **Modo cloud**: roda como passo explícito do processo de deploy (CI/CD), antes de trocar o tráfego pra nova versão — nunca automático no boot, pra evitar duas instâncias tentando migrar ao mesmo tempo em um ambiente com múltiplas réplicas

Migration que precisa de dado default pra coluna nova em tabela já populada (ex: adicionar `uses_tables` em `store_settings`) deve sempre ter um valor `DEFAULT` explícito no SQL gerado — nunca depender de a aplicação preencher depois, porque entre o deploy do schema novo e o primeiro request que preencheria o valor, o campo fica nulo e pode quebrar uma leitura em outro lugar do código que assume não-nulo.

## 15. Requisitos Não-Funcionais

Dimensionamento pensado pra um único estabelecimento de porte pequeno/médio (bar/restaurante), não pra escala multi-tenant nesta etapa:

- **Volume esperado**: até ~30 mesas/comandas simultâneas, pico de ~15 lançamentos de item por minuto no rush. O Postgres aguenta essa carga com folga (e o pool de conexões é de 10 por padrão, tudo no mesmo host). Se o estabelecimento crescer muito além disso, é sinal pra subir de instância (`DATABASE_POOL_MAX` + Postgres maior), não pra trocar de banco.
- **Latência aceitável**: ações do garçom (adicionar item, marcar entregue) devem responder em menos de 300ms em modo local (rede interna, sem round-trip de internet) — se não bater isso, é sintoma de problema real (query sem índice, lock desnecessário), não de expectativa mal calibrada.
- **Disponibilidade em modo local**: depende só da energia e do Wi-Fi do estabelecimento — não há SLA formal, mas o sistema precisa voltar a funcionar sozinho depois de queda de energia (`restart: unless-stopped` nos containers; o Postgres em volume nomeado é recovery-safe e não corrompe em desligamento abrupto). O `pg_dump` do `deploy/backup.sh` é o mecanismo de restauração.
- **Segurança em modo cloud**: HTTPS obrigatório (nunca servir a API em HTTP puro pra fora do `localhost`); CORS restrito à origem do app cliente, não `*`; `JWT_SECRET` nunca commitado, sempre injetado via variável de ambiente do provedor.
- **Segurança em modo local**: rede Wi-Fi interna do estabelecimento é o perímetro de confiança — não há autenticação de rede adicional (VPN, etc.) prevista nesta etapa; é uma decisão consciente de simplicidade, válida enquanto o Wi-Fi do local não for aberto ao público na mesma rede dos tablets.
> **Atualização 2026**: a lacuna de `SYNC_ENABLED` foi resolvida por tooling —
> `deploy/backup.sh` faz `pg_dump` (snapshot consistente, sem derrubar o banco) e
> o `deploy/README.md` traz o agendamento por cron. O que continua sendo do
> operador: agendar o cron e copiar as cópias pra fora do servidor — perda do
> hardware físico continua sendo perda total sem isso, e vale deixar explícito
> pro dono do estabelecimento antes do primeiro deploy.
