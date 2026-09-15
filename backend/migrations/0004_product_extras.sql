-- ============================================================
-- Migration 0004 — cadastro de produto: descrição, foto e iFood
-- Adiciona colunas de cadastro enriquecido em product:
--   description   texto livre do produto
--   image_path    caminho da foto servida via /uploads (null = sem foto)
--                 o arquivo fica no disco em <UPLOADS_DIR>/<product_id>.<ext>
--   ifood_enabled flag de disponibilidade no iFood
--   ifood_sku     código/id do produto no catálogo iFood
-- Nunca editar depois de commitada; mudanças futuras entram como novos
-- arquivos (§14.5).
-- ============================================================

ALTER TABLE product ADD COLUMN description    TEXT     NOT NULL DEFAULT '';
ALTER TABLE product ADD COLUMN image_path     TEXT;
ALTER TABLE product ADD COLUMN ifood_enabled  INTEGER  NOT NULL DEFAULT 0;
ALTER TABLE product ADD COLUMN ifood_sku      TEXT;