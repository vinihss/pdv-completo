-- ============================================================
-- Migration 0009 — Integração iFood (Order/Catalog API)
-- 1. order.channel ganha "ifood" (recria a tabela — mesma técnica da 0003).
-- 2. Índice único parcial em external_ref: idempotência por pedido iFood
--    (externalRef = orderId do iFood).
-- 3. ifood_event: dedupe + bookkeeping de ACK (persistir antes do ACK pára o
--    throttle do iFood). ifood_state: token/merchant/últimos timestamps.
-- Nunca editar depois de commitada; mudanças futuras entram como novos
-- arquivos.
-- ============================================================

-- SQLite não permite alterar CHECK via ALTER TABLE: recria a tabela
-- seguindo a técnica oficial de 12 passos (mesma já usada na 0002/0003).
PRAGMA foreign_keys = OFF;

CREATE TABLE "order_new" (
    id              TEXT PRIMARY KEY,
    table_id        TEXT REFERENCES restaurant_table(id) ON DELETE RESTRICT,
    customer_id     TEXT REFERENCES customer(id) ON DELETE SET NULL,
    tab_label       TEXT,
    waiter_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
    opened_at       TEXT NOT NULL DEFAULT (current_timestamp),
    closed_at       TEXT,
    payment_method       TEXT CHECK (payment_method IN ('cash','card','pix','other')),
    payment_confirmed_at TEXT,
    payment_confirmed_by TEXT REFERENCES "user"(id),
    channel         TEXT NOT NULL DEFAULT 'balcao' CHECK (channel IN ('balcao','whatsapp','web','ifood')),
    external_ref    TEXT,
    delivery_fee    REAL,
    cancel_reason   TEXT,
    CHECK (table_id IS NOT NULL OR customer_id IS NOT NULL OR tab_label IS NOT NULL)
);

INSERT INTO "order_new" (id, table_id, customer_id, tab_label, waiter_id, status, opened_at, closed_at, payment_method, payment_confirmed_at, payment_confirmed_by, channel, external_ref, delivery_fee, cancel_reason)
SELECT id, table_id, customer_id, tab_label, waiter_id, status, opened_at, closed_at, payment_method, payment_confirmed_at, payment_confirmed_by, channel, external_ref, delivery_fee, cancel_reason
FROM "order";

DROP TABLE "order";
ALTER TABLE "order_new" RENAME TO "order";

CREATE INDEX IF NOT EXISTS idx_order_table ON "order"(table_id);
CREATE INDEX IF NOT EXISTS idx_order_customer ON "order"(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_status ON "order"(status);
-- Idempotência por pedido iFood (external_ref é único quando existe)
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_external_ref_unique ON "order"(external_ref) WHERE external_ref IS NOT NULL;

-- Log/dedupe dos eventos do polling — status é o bookkeeping de ACK.
CREATE TABLE IF NOT EXISTS ifood_event (
    id           TEXT PRIMARY KEY,
    order_ref    TEXT,
    code         TEXT NOT NULL,
    full_code    TEXT,
    status       TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed','acked')),
    raw          TEXT NOT NULL DEFAULT '{}',
    processed_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_ifood_event_status ON ifood_event(status);
CREATE INDEX IF NOT EXISTS idx_ifood_event_order ON ifood_event(order_ref);

-- KV singleton de estado da integração (token, merchant, timestamps).
CREATE TABLE IF NOT EXISTS ifood_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (current_timestamp)
);

PRAGMA foreign_keys = ON;