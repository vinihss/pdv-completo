-- ============================================================
-- 0008_stores_and_store_id — Schema multi-tenant (stores + store_id nas tabelas reais).
-- Baseado em PLANO_PAGARME.md (commit dfb2ae9) e nomes REAIS de 0001_init.sql.
-- NÃO inventa nomes de tabela (users, orders, products, etc.).
-- Idempotente: IF NOT EXISTS / IF EXISTS no col / índice.
-- NÃO faz NOT NULL, NÃO dropa PK, NÃO altera PK do singleton.
-- ============================================================

-- ---------------------------------------------------------------- stores
CREATE TABLE IF NOT EXISTS stores (
  id                         TEXT PRIMARY KEY,
  name                       TEXT NOT NULL,
  slug                       TEXT UNIQUE NOT NULL,
  owner_user_id              TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  status                     TEXT NOT NULL DEFAULT 'active',
  pagarme_recipient_id       TEXT,
  split_platform_percentage  REAL NOT NULL DEFAULT 5,
  created_at                 TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at                 TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_stores_slug ON stores(slug);

-- Store padrão (singleton de migração) — respeita singleton existente do store_settings
INSERT INTO stores (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Loja Padrão', 'default', 'active')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- store_id nas tabelas principais (nomes REAIS)
DO $$
DECLARE
  store_default TEXT := '00000000-0000-0000-0000-000000000001';
BEGIN
  -- Principais (exatamente como especificado)
  ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE "order"         ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE order_payment    ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE "user"           ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE customer         ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE restaurant_table ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE order_item       ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE product          ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;

  -- Estoque / entrega / infraestrutura (lista completa do usuário)
  ALTER TABLE purchase         ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE purchase_item    ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE supplier         ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE stock_movement   ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE delivery         ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE audit_log        ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE idempotency_key  ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE outbox_event     ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE ifood_event      ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE ifood_state      ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE customer_address ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE geocoding_cache  ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE whatsapp_connection    ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
  ALTER TABLE whatsapp_conversation  ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES stores(id) ON DELETE SET NULL;
END $$;

-- ---------------------------------------------------------------- backfill (idempotente)
UPDATE store_settings SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE "order"         SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE order_payment    SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE "user"           SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE customer         SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE restaurant_table SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE order_item       SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE product          SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;

UPDATE purchase         SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE purchase_item    SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE supplier         SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE stock_movement   SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE delivery         SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE audit_log        SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE idempotency_key  SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE outbox_event     SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE ifood_event      SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE ifood_state      SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE customer_address SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE geocoding_cache  SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE whatsapp_connection    SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE whatsapp_conversation  SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;

-- ---------------------------------------------------------------- índices por store_id nas principais
CREATE INDEX IF NOT EXISTS idx_store_settings_store  ON store_settings(store_id);
CREATE INDEX IF NOT EXISTS idx_order_store           ON "order"(store_id);
CREATE INDEX IF NOT EXISTS idx_order_payment_store    ON order_payment(store_id);
CREATE INDEX IF NOT EXISTS idx_user_store            ON "user"(store_id);
CREATE INDEX IF NOT EXISTS idx_customer_store         ON customer(store_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_table_store ON restaurant_table(store_id);
CREATE INDEX IF NOT EXISTS idx_order_item_store       ON order_item(store_id);
CREATE INDEX IF NOT EXISTS idx_product_store          ON product(store_id);

CREATE INDEX IF NOT EXISTS idx_purchase_store         ON purchase(store_id);
CREATE INDEX IF NOT EXISTS idx_purchase_item_store    ON purchase_item(store_id);
CREATE INDEX IF NOT EXISTS idx_supplier_store         ON supplier(store_id);
CREATE INDEX IF NOT EXISTS idx_stock_movement_store   ON stock_movement(store_id);
CREATE INDEX IF NOT EXISTS idx_delivery_store         ON delivery(store_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_store        ON audit_log(store_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_key_store  ON idempotency_key(store_id);
CREATE INDEX IF NOT EXISTS idx_outbox_event_store     ON outbox_event(store_id);
CREATE INDEX IF NOT EXISTS idx_ifood_event_store      ON ifood_event(store_id);
CREATE INDEX IF NOT EXISTS idx_ifood_state_store      ON ifood_state(store_id);
CREATE INDEX IF NOT EXISTS idx_customer_address_store ON customer_address(store_id);
CREATE INDEX IF NOT EXISTS idx_geocoding_cache_store  ON geocoding_cache(store_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_connection_store    ON whatsapp_connection(store_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversation_store  ON whatsapp_conversation(store_id);
