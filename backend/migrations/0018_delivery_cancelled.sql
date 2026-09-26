-- ============================================================
-- Migration 0018 — estado "cancelled" na entrega (máquina de estado)
-- Máquina de estado do pedido do cliente (customer-order-state.ts):
-- cancelamento (pelo manager ou pelo cliente) precisa ser distinto de
-- "failed" ("problema na entrega") — entrega cancelada não pode aparecer
-- como falha no painel do entregador nem na mensagem pro cliente.
-- Nunca editar depois de commitada; mudanças futuras entram como novos
-- arquivos (§14.5).
-- ============================================================

-- SQLite não permite alterar CHECK via ALTER TABLE: recria a tabela
-- seguindo a técnica oficial de 12 passos (mesma já usada nas 0002/0003
-- para user.role e orders.status).
PRAGMA foreign_keys = OFF;

CREATE TABLE "delivery_new" (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL UNIQUE REFERENCES "order"(id) ON DELETE CASCADE,
    courier_id      TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    address         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'awaiting_courier'
                        CHECK (status IN ('awaiting_courier','out_for_delivery','delivered','failed','cancelled')),
    dispatched_at   TEXT,
    delivered_at    TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp)
);

INSERT INTO "delivery_new" (id, order_id, courier_id, address, status, dispatched_at, delivered_at, notes, created_at)
SELECT id, order_id, courier_id, address, status, dispatched_at, delivered_at, notes, created_at
FROM "delivery";

DROP TABLE "delivery";
ALTER TABLE "delivery_new" RENAME TO "delivery";

CREATE INDEX IF NOT EXISTS idx_delivery_courier ON delivery(courier_id);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery(status);

PRAGMA foreign_keys = ON;
