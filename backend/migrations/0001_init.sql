-- ============================================================
-- Migration 0001 — schema inicial (SQLite, modo local)
-- Espelha 01-backend-spec.md §4. Nunca editar depois de commitada;
-- mudanças futuras de schema entram como novos arquivos (§14.5).
-- ============================================================

CREATE TABLE IF NOT EXISTS "user" (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('waiter','kitchen','manager')),
    pin_hash        TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp),
    updated_at      TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE TABLE IF NOT EXISTS category (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    display_order   INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE TABLE IF NOT EXISTS product (
    id              TEXT PRIMARY KEY,
    category_id     TEXT REFERENCES category(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    price           REAL NOT NULL CHECK (price >= 0),
    variations      TEXT NOT NULL DEFAULT '[]',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp),
    updated_at      TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_product_category ON product(category_id);

CREATE TABLE IF NOT EXISTS restaurant_table (
    id              TEXT PRIMARY KEY,
    number          TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free','occupied','closing')),
    created_at      TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE TABLE IF NOT EXISTS customer (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    phone           TEXT,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_customer_name ON customer(name);
CREATE INDEX IF NOT EXISTS idx_customer_phone ON customer(phone);

CREATE TABLE IF NOT EXISTS "order" (
    id              TEXT PRIMARY KEY,
    table_id        TEXT REFERENCES restaurant_table(id) ON DELETE RESTRICT,
    customer_id     TEXT REFERENCES customer(id) ON DELETE SET NULL,
    tab_label       TEXT,
    waiter_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    opened_at       TEXT NOT NULL DEFAULT (current_timestamp),
    closed_at       TEXT,
    payment_method       TEXT CHECK (payment_method IN ('cash','card','pix','other')),
    payment_confirmed_at TEXT,
    payment_confirmed_by TEXT REFERENCES "user"(id),
    CHECK (table_id IS NOT NULL OR customer_id IS NOT NULL OR tab_label IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_order_table ON "order"(table_id);
CREATE INDEX IF NOT EXISTS idx_order_customer ON "order"(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_status ON "order"(status);

CREATE TABLE IF NOT EXISTS order_item (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    unit_price      REAL NOT NULL,
    selected_variations TEXT NOT NULL DEFAULT '{}',
    notes           TEXT,
    status          TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','ready','delivered','cancelled')),
    version         INTEGER NOT NULL DEFAULT 1,
    created_by      TEXT NOT NULL REFERENCES "user"(id),
    created_at      TEXT NOT NULL DEFAULT (current_timestamp),
    updated_at      TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_order_item_order ON order_item(order_id);
CREATE INDEX IF NOT EXISTS idx_order_item_status ON order_item(status);

CREATE TABLE IF NOT EXISTS store_settings (
    id                        TEXT PRIMARY KEY DEFAULT 'singleton',
    merchant_name             TEXT NOT NULL,
    merchant_city             TEXT NOT NULL,
    pix_key                   TEXT NOT NULL DEFAULT '',
    pix_key_type              TEXT NOT NULL DEFAULT 'phone' CHECK (pix_key_type IN ('cpf','cnpj','email','phone','random')),
    uses_tables               INTEGER NOT NULL DEFAULT 1,
    kitchen_enabled           INTEGER NOT NULL DEFAULT 1,
    enabled_payment_methods   TEXT NOT NULL DEFAULT '["cash","card","pix","other"]',
    kitchen_prep_warn_min     INTEGER NOT NULL DEFAULT 3,
    kitchen_prep_urgent_min   INTEGER NOT NULL DEFAULT 6,
    kitchen_pickup_urgent_min INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES "user"(id),
    action      TEXT NOT NULL,
    order_id    TEXT REFERENCES "order"(id),
    details     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_audit_log_order ON audit_log(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

CREATE TABLE IF NOT EXISTS idempotency_key (
    correlation_id  TEXT PRIMARY KEY,
    endpoint        TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_body   TEXT,
    response_status INTEGER,
    status          TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
    created_at      TEXT NOT NULL DEFAULT (current_timestamp),
    expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_key(expires_at);

CREATE TABLE IF NOT EXISTS outbox_event (
    id           TEXT PRIMARY KEY,
    event_type   TEXT NOT NULL,
    payload      TEXT NOT NULL,
    room         TEXT NOT NULL,
    published    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_outbox_published ON outbox_event(published);
