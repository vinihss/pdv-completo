-- ============================================================
-- Migration 0005 — grupo/estação de produção (cozinha)
-- Novo cadastro kitchen_group + vínculo opcional no produto.
-- Produto sem kitchen_group_id não aparece na tela da cozinha
-- (itens de bar/balcão ficam fora do fluxo de produção).
-- Nunca editar depois de commitada; mudanças futuras entram como
-- novos arquivos (§14.5).
-- ============================================================

CREATE TABLE IF NOT EXISTS kitchen_group (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    display_order   INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_kitchen_group_display_order ON kitchen_group(display_order);

ALTER TABLE product ADD COLUMN kitchen_group_id TEXT REFERENCES kitchen_group(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_product_kitchen_group ON product(kitchen_group_id);