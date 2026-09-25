-- ============================================================
-- Migration 0016 — controle de estoque (Etapa 2, escopo simples).
--
-- Modelo: estoque POR PRODUTO (quantidade própria), com ledger
-- `stock_movement` como fonte da verdade — o saldo é a soma dos
-- deltas, não uma coluna cacheada (sem drift entre contador e
-- histórico). Lançamento de item = movimento 'sale' (-qty);
-- remoção/cancelamento = 'refund' (+qty); ajuste/compra manual
-- = 'adjustment'/'purchase'. Design preparado para evoluir a
-- ficha técnica depois: a tabela já guarda deltas genéricos.
--
-- Colunas novas em `product` (config, não estado):
--   - cost_price          custo unitário de compra (para margem)
--   - low_stock_threshold alerta visual de estoque baixo
--   - track_stock         produto entra no controle (default 0 =
--                         produtos antigos seguem sem estoque)
-- `order_item.cost_price`: snapshot do custo no lançamento (mesma
-- disciplina do unit_price — margem histórica correta).
-- `store_settings.inventory_enabled`: toggle global da feature
-- (default 0 — nenhuma instalação existente muda de comportamento).
-- ============================================================

ALTER TABLE product ADD COLUMN cost_price REAL NOT NULL DEFAULT 0 CHECK (cost_price >= 0);
ALTER TABLE product ADD COLUMN low_stock_threshold REAL NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0);
ALTER TABLE product ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0,1));

ALTER TABLE order_item ADD COLUMN cost_price REAL NOT NULL DEFAULT 0 CHECK (cost_price >= 0);

ALTER TABLE store_settings ADD COLUMN inventory_enabled INTEGER NOT NULL DEFAULT 0 CHECK (inventory_enabled IN (0,1));

CREATE TABLE IF NOT EXISTS stock_movement (
    id             TEXT PRIMARY KEY,
    product_id     TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    type           TEXT NOT NULL CHECK (type IN ('sale','refund','purchase','adjustment')),
    quantity_delta REAL NOT NULL CHECK (quantity_delta != 0),
    order_id       TEXT REFERENCES "order"(id) ON DELETE SET NULL,
    order_item_id  TEXT REFERENCES order_item(id) ON DELETE SET NULL,
    note           TEXT,
    created_by     TEXT NOT NULL REFERENCES "user"(id),
    created_at     TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_stock_movement_product ON stock_movement(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movement_order ON stock_movement(order_id);