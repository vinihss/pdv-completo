-- ============================================================
-- Migration 0003 — cancelamento de pedido (cancelOrderUsecase)
-- Espelha a necessidade descoberta na fase de delivery: um pedido com
-- entrega marcada "failed" não tinha nenhum caminho de resolução — nem
-- fechar (exige todo item delivered + payment), nem cancelar (não existia).
-- Nunca editar depois de commitada; mudanças futuras entram como novos
-- arquivos (§14.5).
-- ============================================================

-- SQLite não permite alterar CHECK via ALTER TABLE: recria a tabela
-- seguindo a técnica oficial de 12 passos (mesma já usada na 0002 pra
-- adicionar "courier"/"system" em user.role).
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
    channel         TEXT NOT NULL DEFAULT 'balcao' CHECK (channel IN ('balcao','whatsapp','web')),
    external_ref    TEXT,
    delivery_fee    REAL,
    cancel_reason   TEXT,
    CHECK (table_id IS NOT NULL OR customer_id IS NOT NULL OR tab_label IS NOT NULL)
);

INSERT INTO "order_new" (id, table_id, customer_id, tab_label, waiter_id, status, opened_at, closed_at, payment_method, payment_confirmed_at, payment_confirmed_by, channel, external_ref, delivery_fee)
SELECT id, table_id, customer_id, tab_label, waiter_id, status, opened_at, closed_at, payment_method, payment_confirmed_at, payment_confirmed_by, channel, external_ref, delivery_fee
FROM "order";

DROP TABLE "order";
ALTER TABLE "order_new" RENAME TO "order";

CREATE INDEX IF NOT EXISTS idx_order_table ON "order"(table_id);
CREATE INDEX IF NOT EXISTS idx_order_customer ON "order"(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_status ON "order"(status);

PRAGMA foreign_keys = ON;
