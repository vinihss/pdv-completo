-- ============================================================
-- 0001_init — schema Postgres OFICIAL do PDV.
--
-- Schema já consolidado: as 22 migrations SQLite históricas
-- (0001..0022) viraram um único bootstrap. O mapeamento de tipos
-- segue src/infra/db/schema.ts — leia o comentário de cabecera
-- daquele arquivo antes de mexer aqui.
--
-- Convenções que o app depende (ver schema.ts):
--   * PK text + id gerado no app (crypto.randomUUID) — preserva os
--     ids não-UUID já existentes: 'system', 'singleton', ids do iFood,
--     telefone e o cardápio Unami (cat-unami-*, p-unami-NNN).
--   *_at / expires_at em TEXT ISO-8601 UTC. O DEFAULT abaixo gera
--     EXATAMENTE o mesmo formato de Date.prototype.toISOString()
--     (3 casas de milissegundo + 'Z'), o que faz a ordenação
--     lexicográfica do text coincidir com a cronológica.
--   * JSON em TEXT (o app serializa na borda) — ver domain/variations.ts.
--   * dinheiro/quantidade em REAL (double precision) para o node-postgres
--     devolver number; NUMERIC voltaria string e quebraria round2/moneyEq.
-- ============================================================

-- ---------------------------------------------------------------- enums
CREATE TYPE user_role AS ENUM ('waiter', 'kitchen', 'manager', 'courier', 'system', 'cashier');
CREATE TYPE table_status AS ENUM ('free', 'occupied', 'closing');
CREATE TYPE order_status AS ENUM ('open', 'closed', 'cancelled');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'pix', 'other');
CREATE TYPE channel AS ENUM ('balcao', 'whatsapp', 'web', 'ifood');
CREATE TYPE order_item_status AS ENUM ('ordered', 'ready', 'delivered', 'cancelled');
CREATE TYPE stock_movement_type AS ENUM ('sale', 'refund', 'purchase', 'adjustment');
CREATE TYPE cash_drawer_status AS ENUM ('open', 'closed');
CREATE TYPE cash_movement_type AS ENUM ('sangria', 'suprimento');
CREATE TYPE ifood_event_status AS ENUM ('received', 'processed', 'ignored', 'failed', 'acked');
CREATE TYPE whatsapp_state AS ENUM ('welcome', 'browsing', 'cart', 'checkout', 'done', 'awaiting_location', 'awaiting_confirmation', 'awaiting_correction');
CREATE TYPE delivery_status AS ENUM ('awaiting_courier', 'out_for_delivery', 'delivered', 'failed', 'cancelled');
CREATE TYPE pix_key_type AS ENUM ('cpf', 'cnpj', 'email', 'phone', 'random');
CREATE TYPE idempotency_status AS ENUM ('processing', 'completed', 'failed');

-- ---------------------------------------------------------------- pessoas
CREATE TABLE "user" (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  role             user_role NOT NULL,
  pin_hash         TEXT NOT NULL,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at       TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE customer (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_customer_name ON customer(name);
CREATE INDEX idx_customer_phone ON customer(phone);

CREATE TABLE restaurant_table (
  id         TEXT PRIMARY KEY,
  number     TEXT NOT NULL UNIQUE,
  status     table_status NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- ---------------------------------------------------------------- catálogo
CREATE TABLE category (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE kitchen_group (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE product (
  id                  TEXT PRIMARY KEY,
  category_id         TEXT REFERENCES category(id) ON DELETE SET NULL,
  kitchen_group_id    TEXT REFERENCES kitchen_group(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  price               REAL NOT NULL CHECK (price >= 0),
  variations          TEXT NOT NULL DEFAULT '[]',
  image_path          TEXT,
  ifood_enabled       BOOLEAN NOT NULL DEFAULT false,
  ifood_sku           TEXT,
  featured            BOOLEAN NOT NULL DEFAULT false,
  cost_price          REAL NOT NULL DEFAULT 0,
  low_stock_threshold REAL NOT NULL DEFAULT 0,
  track_stock         BOOLEAN NOT NULL DEFAULT false,
  unit                TEXT NOT NULL DEFAULT 'un',
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_product_category ON product(category_id);
CREATE INDEX idx_product_kitchen_group ON product(kitchen_group_id);

-- ---------------------------------------------------------------- comandas
CREATE TABLE "order" (
  id                    TEXT PRIMARY KEY,
  table_id              TEXT REFERENCES restaurant_table(id) ON DELETE RESTRICT,
  customer_id           TEXT REFERENCES customer(id) ON DELETE SET NULL,
  tab_label             TEXT,
  waiter_id             TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  status                order_status NOT NULL DEFAULT 'open',
  opened_at             TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  closed_at             TEXT,
  payment_method        payment_method,
  payment_confirmed_at  TEXT,
  payment_confirmed_by  TEXT REFERENCES "user"(id),
  channel               channel NOT NULL DEFAULT 'balcao',
  external_ref          TEXT,
  delivery_fee          REAL,
  cancel_reason         TEXT,
  ifood_payments        TEXT,
  CONSTRAINT chk_order_identification_required
    CHECK (table_id IS NOT NULL OR customer_id IS NOT NULL OR tab_label IS NOT NULL)
);
CREATE INDEX idx_order_table ON "order"(table_id);
CREATE INDEX idx_order_customer ON "order"(customer_id);
CREATE INDEX idx_order_status ON "order"(status);
CREATE INDEX idx_order_waiter ON "order"(waiter_id);
-- O polling do iFood pode reencontrar o mesmo pedido; sem este índice
-- único ele abriria uma segunda comanda para o mesmo external_ref.
CREATE UNIQUE INDEX uq_order_channel_external_ref ON "order"(channel, external_ref);

CREATE TABLE order_payment (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  method         payment_method NOT NULL,
  amount         REAL NOT NULL CHECK (amount > 0),
  received       REAL,
  change         REAL,
  confirmed      BOOLEAN NOT NULL DEFAULT false,
  confirmed_at   TEXT,
  confirmed_by   TEXT REFERENCES "user"(id),
  created_by     TEXT NOT NULL REFERENCES "user"(id),
  created_at     TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_order_payment_order ON order_payment(order_id);

CREATE TABLE order_item (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  product_id          TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  unit_price          REAL NOT NULL,
  cost_price          REAL NOT NULL DEFAULT 0,
  selected_variations TEXT NOT NULL DEFAULT '{}',
  notes               TEXT,
  status              order_item_status NOT NULL DEFAULT 'ordered',
  version             INTEGER NOT NULL DEFAULT 1,
  created_by          TEXT NOT NULL REFERENCES "user"(id),
  created_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_order_item_order ON order_item(order_id);
CREATE INDEX idx_order_item_product ON order_item(product_id);

-- ---------------------------------------------------------------- compras / estoque
CREATE TABLE supplier (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  tax_id     TEXT,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE purchase (
  id             TEXT PRIMARY KEY,
  supplier_id    TEXT REFERENCES supplier(id) ON DELETE SET NULL,
  invoice_number TEXT,
  issued_on      TEXT,
  note           TEXT,
  total          REAL NOT NULL DEFAULT 0,
  created_by     TEXT NOT NULL REFERENCES "user"(id),
  created_at     TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE purchase_item (
  id          TEXT PRIMARY KEY,
  -- Ordem de inserção da linha no documento (o `rowid` do SQLite dava isso de
  -- graça). Sem desempate explícito, duas linhas do mesmo produto voltariam
  -- em ordem arbitrária na leitura do documento.
  seq         BIGSERIAL NOT NULL,
  purchase_id TEXT NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  quantity    REAL NOT NULL,
  unit_cost   REAL NOT NULL,
  line_total  REAL NOT NULL DEFAULT 0,
  batch_no    TEXT,
  expiry_date TEXT,
  created_by  TEXT NOT NULL REFERENCES "user"(id),
  created_at  TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_purchase_item_purchase ON purchase_item(purchase_id);

-- seq (bigserial) = ordem de inserção. A média móvel é um REPLAY do ledger,
-- então a ordem precisa ser estável: no SQLite isso era o `rowid` implícito,
-- que o Postgres não tem.
CREATE TABLE stock_movement (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL NOT NULL,
  product_id       TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  type             stock_movement_type NOT NULL,
  quantity_delta   REAL NOT NULL,
  unit_cost        REAL,
  purchase_item_id TEXT REFERENCES purchase_item(id) ON DELETE SET NULL,
  order_id         TEXT REFERENCES "order"(id) ON DELETE SET NULL,
  order_item_id    TEXT REFERENCES order_item(id) ON DELETE SET NULL,
  note             TEXT,
  created_by       TEXT NOT NULL REFERENCES "user"(id),
  created_at       TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_stock_movement_product ON stock_movement(product_id);
CREATE INDEX idx_stock_movement_order ON stock_movement(order_id);
CREATE INDEX idx_stock_movement_order_item ON stock_movement(order_item_id);
CREATE INDEX idx_stock_movement_product_seq ON stock_movement(product_id, seq);

-- ---------------------------------------------------------------- fluxo de caixa
CREATE TABLE cash_drawer (
  id                 TEXT PRIMARY KEY,
  status             cash_drawer_status NOT NULL DEFAULT 'open',
  opened_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  opened_by          TEXT NOT NULL REFERENCES "user"(id),
  opening_amount     REAL NOT NULL DEFAULT 0,
  closed_at          TEXT,
  closed_by          TEXT REFERENCES "user"(id),
  closing_expected   REAL,
  closing_counted    REAL,
  closing_difference REAL,
  closing_note       TEXT,
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
-- Uma sessão aberta por vez, garantido no banco (antes era só regra de usecase).
CREATE UNIQUE INDEX uq_cash_drawer_single_open ON cash_drawer(status) WHERE status = 'open';
CREATE INDEX idx_cash_drawer_opened_at ON cash_drawer(opened_at);

CREATE TABLE cash_drawer_movement (
  id            TEXT PRIMARY KEY,
  drawer_id     TEXT NOT NULL REFERENCES cash_drawer(id) ON DELETE CASCADE,
  type          cash_movement_type NOT NULL,
  amount        REAL NOT NULL,
  note          TEXT,
  ref_order_id  TEXT REFERENCES "order"(id),
  created_by    TEXT NOT NULL REFERENCES "user"(id),
  created_at    TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_cash_drawer_movement_drawer ON cash_drawer_movement(drawer_id);

-- ---------------------------------------------------------------- configuração
CREATE TABLE store_settings (
  id                          TEXT PRIMARY KEY DEFAULT 'singleton',
  merchant_name               TEXT NOT NULL,
  merchant_city               TEXT NOT NULL,
  logo_path                   TEXT,
  brand_color                 TEXT NOT NULL DEFAULT '#f59e0b',
  pix_key                     TEXT NOT NULL DEFAULT '',
  pix_key_type                pix_key_type NOT NULL DEFAULT 'phone',
  uses_tables                 BOOLEAN NOT NULL DEFAULT true,
  kitchen_enabled             BOOLEAN NOT NULL DEFAULT true,
  uses_delivery               BOOLEAN NOT NULL DEFAULT true,
  ifood_integration_enabled   BOOLEAN NOT NULL DEFAULT false,
  inventory_enabled           BOOLEAN NOT NULL DEFAULT false,
  purchase_enabled            BOOLEAN NOT NULL DEFAULT false,
  enabled_payment_methods     TEXT NOT NULL DEFAULT '["cash","card","pix","other"]',
  kitchen_prep_warn_min       INTEGER NOT NULL DEFAULT 3,
  kitchen_prep_urgent_min     INTEGER NOT NULL DEFAULT 6,
  kitchen_pickup_urgent_min   INTEGER NOT NULL DEFAULT 5,
  delivery_fee                REAL NOT NULL DEFAULT 0,
  restaurant_lat              REAL,
  restaurant_long             REAL,
  free_delivery_min           REAL NOT NULL DEFAULT 0,
  delivery_fee_tiers          TEXT NOT NULL DEFAULT '[]'
);

-- ---------------------------------------------------------------- infraestrutura
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id),
  action     TEXT NOT NULL,
  order_id   TEXT REFERENCES "order"(id),
  details    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_order ON audit_log(order_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

CREATE TABLE idempotency_key (
  correlation_id TEXT PRIMARY KEY,
  endpoint       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  response_body  TEXT,
  response_status INTEGER,
  status         idempotency_status NOT NULL DEFAULT 'processing',
  created_at     TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_idempotency_key_expires ON idempotency_key(expires_at);

CREATE TABLE outbox_event (
  id          TEXT PRIMARY KEY,
  -- Ordem de inserção: sem `seq`, dois eventos com o mesmo `created_at`
  -- (mesma milissegundo) teriam ordem indefinida — o `rowid` do SQLite
  -- resolvia, a sequência é a desambiguação no Postgres.
  seq         BIGSERIAL NOT NULL,
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  room        TEXT NOT NULL,
  published   BOOLEAN NOT NULL DEFAULT false,
  created_at  TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
-- O dispatcher faz poll em "não publicado, mais antigo primeiro".
CREATE INDEX idx_outbox_event_unpublished ON outbox_event(created_at, seq) WHERE published = false;

-- ---------------------------------------------------------------- iFood
CREATE TABLE ifood_event (
  id           TEXT PRIMARY KEY,
  order_ref    TEXT,
  code         TEXT NOT NULL,
  full_code    TEXT,
  status       ifood_event_status NOT NULL DEFAULT 'received',
  raw          TEXT NOT NULL DEFAULT '{}',
  processed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_ifood_event_status ON ifood_event(status);

CREATE TABLE ifood_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- ---------------------------------------------------------------- self-service / delivery
CREATE TABLE customer_address (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  label        TEXT,
  street       TEXT NOT NULL,
  number       TEXT NOT NULL,
  complement   TEXT,
  neighborhood TEXT NOT NULL,
  city         TEXT NOT NULL,
  reference    TEXT,
  latitude     REAL,
  longitude    REAL,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_customer_address_customer ON customer_address(customer_id);

CREATE TABLE whatsapp_conversation (
  phone            TEXT PRIMARY KEY,
  state            whatsapp_state NOT NULL DEFAULT 'welcome',
  cart_items       TEXT NOT NULL DEFAULT '[]',
  customer_name    TEXT,
  delivery_address TEXT,
  updated_at       TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  expires_at       TEXT NOT NULL
);

CREATE TABLE delivery (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL UNIQUE REFERENCES "order"(id) ON DELETE CASCADE,
  courier_id         TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  address            TEXT NOT NULL,
  distance_km        REAL,
  estimated_minutes  INTEGER,
  status             delivery_status NOT NULL DEFAULT 'awaiting_courier',
  dispatched_at      TEXT,
  delivered_at       TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_delivery_status ON delivery(status);
CREATE INDEX idx_delivery_courier ON delivery(courier_id);

CREATE TABLE customer_cart (
  phone      TEXT PRIMARY KEY,
  items      TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_customer_cart_expires ON customer_cart(expires_at);

CREATE TABLE geocoding_cache (
  cache_key  TEXT PRIMARY KEY,
  response   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_geocoding_cache_expires ON geocoding_cache(expires_at);

-- ---------------------------------------------------------------- seed de sistema
-- Usuário técnico: alvo de FK para order.waiter_id e audit_log.user_id em
-- pedidos self-service, que não têm garçom nem gerente responsável.
-- active = false impede login (mesmo mecanismo de desativar funcionário);
-- pin_hash é placeholder inutilizável porque o login já bloqueia active = false
-- antes de comparar PIN.
INSERT INTO "user" (id, name, role, pin_hash, active)
VALUES ('system', 'Pedidos automáticos (self-service)', 'system', 'SYSTEM_ACCOUNT_NO_LOGIN', false)
ON CONFLICT (id) DO NOTHING;
