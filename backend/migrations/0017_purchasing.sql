-- ============================================================
-- Migration 0017 — compras e custo médio móvel (estoque profissional).
--
-- Habilita por instalação via `store_settings.purchase_enabled` (default 0
-- — nenhuma instalação existente muda de comportamento).
--
-- O que entra:
--   - `product.unit`           unidade de medida (display; ficha técnica usa
--                              a mesma unidade do ingrediente — sem conversão).
--   - `supplier`               fornecedor (CRUD do gerente).
--   - `purchase`/`purchase_item` entrada de mercadoria COMO DOCUMENTO
--                              multi-item (fornecedor, nº nota, data, custo
--                              unitário por linha, lote/validade informativos).
--   - `stock_movement.unit_cost`        custo unitário no evento de valoração
--                              (`purchase`, estoque inicial). A média móvel é
--                              um REPLAY deste ledger — nunca uma coluna de
--                              estado (disciplina do 0016).
--   - `stock_movement.purchase_item_id` vínculo do movimento ao documento
--                              (auditoria entradavenda origem).
--
-- Custo médio móvel: eventos com quantity_delta > 0 E unit_cost NOT NULL
-- re-fazem a média ponderada pelo saldo em mãos no momento da entrada:
--   avg_n = (avg_prev * qty_prev + unit_cost * delta) / (qty_prev + delta)
-- Vendas/refunds/ajuste negativo mudam quantidade, não a média. Ajuste
-- positivo sem custo não muda a média. Antes de qualquer valoração, o
-- custo é o `cost_price` manual do cadastro (fallback).
-- ============================================================

ALTER TABLE product ADD COLUMN unit TEXT NOT NULL DEFAULT 'un';

ALTER TABLE store_settings ADD COLUMN purchase_enabled INTEGER NOT NULL DEFAULT 0 CHECK (purchase_enabled IN (0,1));

CREATE TABLE IF NOT EXISTS supplier (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT,
    tax_id      TEXT,
    active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at  TEXT NOT NULL DEFAULT (current_timestamp),
    updated_at  TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE TABLE IF NOT EXISTS purchase (
    id             TEXT PRIMARY KEY,
    supplier_id    TEXT REFERENCES supplier(id) ON DELETE SET NULL,
    invoice_number TEXT,
    issued_on      TEXT,
    note           TEXT,
    total          REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
    created_by     TEXT NOT NULL REFERENCES "user"(id),
    created_at     TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE TABLE IF NOT EXISTS purchase_item (
    id            TEXT PRIMARY KEY,
    purchase_id   TEXT NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
    product_id    TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
    quantity      REAL NOT NULL CHECK (quantity > 0),
    unit_cost     REAL NOT NULL CHECK (unit_cost >= 0),
    line_total    REAL NOT NULL DEFAULT 0 CHECK (line_total >= 0),
    batch_no      TEXT,
    expiry_date   TEXT,
    created_by    TEXT NOT NULL REFERENCES "user"(id),
    created_at    TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_purchase_item_purchase ON purchase_item(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_item_product ON purchase_item(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_supplier ON purchase(supplier_id);

-- Movimento de estoque passa a carregar custo (evento de valoração) e a
-- origem do documento de compra. ON DELETE SET NULL: apagar o documento não
-- derruba o histórico do ledger.
ALTER TABLE stock_movement ADD COLUMN unit_cost REAL CHECK (unit_cost >= 0);
ALTER TABLE stock_movement ADD COLUMN purchase_item_id TEXT REFERENCES purchase_item(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movement_purchase_item ON stock_movement(purchase_item_id);