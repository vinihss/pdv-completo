-- ============================================================
-- 0012_remove_multi_tenant — remove todo o schema multi-tenant
-- (tabela stores, colunas store_id, índices idx_*store*, colunas
-- Pagar.me ligadas a stores). Reverte 0008/0009/0010/0011 como
-- histórico aplicado — os arquivos continuam, esta migration
-- desfaz o efeito deles. Idempotente.
-- ============================================================

-- 1) Linhas de store_settings que não são o singleton (stores extras
--    criadas em produção, ex.: 'ana-terra') saem antes de dropar a coluna
--    que as distinguia.
DELETE FROM store_settings WHERE id <> 'singleton';

-- 2) Constraint UNIQUE em store_id (criada pela 0011)
ALTER TABLE store_settings DROP CONSTRAINT IF EXISTS uq_store_settings_store;

-- 3) Colunas store_id em todas as tabelas (0008). DROP COLUMN já remove os
--    índices que dependem delas, mas os índices são nomeados — removemos
--    também explicitamente por segurança.
DROP INDEX IF EXISTS idx_store_settings_store;
DROP INDEX IF EXISTS idx_order_store;
DROP INDEX IF EXISTS idx_order_payment_store;
DROP INDEX IF EXISTS idx_user_store;
DROP INDEX IF EXISTS idx_customer_store;
DROP INDEX IF EXISTS idx_restaurant_table_store;
DROP INDEX IF EXISTS idx_order_item_store;
DROP INDEX IF EXISTS idx_product_store;
DROP INDEX IF EXISTS idx_purchase_store;
DROP INDEX IF EXISTS idx_purchase_item_store;
DROP INDEX IF EXISTS idx_supplier_store;
DROP INDEX IF EXISTS idx_stock_movement_store;
DROP INDEX IF EXISTS idx_delivery_store;
DROP INDEX IF EXISTS idx_audit_log_store;
DROP INDEX IF EXISTS idx_idempotency_key_store;
DROP INDEX IF EXISTS idx_outbox_event_store;
DROP INDEX IF EXISTS idx_ifood_event_store;
DROP INDEX IF EXISTS idx_ifood_state_store;
DROP INDEX IF EXISTS idx_customer_address_store;
DROP INDEX IF EXISTS idx_geocoding_cache_store;
DROP INDEX IF EXISTS idx_whatsapp_connection_store;
DROP INDEX IF EXISTS idx_whatsapp_conversation_store;

ALTER TABLE store_settings DROP COLUMN IF EXISTS store_id;
ALTER TABLE "order" DROP COLUMN IF EXISTS store_id;
ALTER TABLE order_payment DROP COLUMN IF EXISTS store_id;
ALTER TABLE "user" DROP COLUMN IF EXISTS store_id;
ALTER TABLE customer DROP COLUMN IF EXISTS store_id;
ALTER TABLE restaurant_table DROP COLUMN IF EXISTS store_id;
ALTER TABLE order_item DROP COLUMN IF EXISTS store_id;
ALTER TABLE product DROP COLUMN IF EXISTS store_id;
ALTER TABLE purchase DROP COLUMN IF EXISTS store_id;
ALTER TABLE purchase_item DROP COLUMN IF EXISTS store_id;
ALTER TABLE supplier DROP COLUMN IF EXISTS store_id;
ALTER TABLE stock_movement DROP COLUMN IF EXISTS store_id;
ALTER TABLE delivery DROP COLUMN IF EXISTS store_id;
ALTER TABLE audit_log DROP COLUMN IF EXISTS store_id;
ALTER TABLE idempotency_key DROP COLUMN IF EXISTS store_id;
ALTER TABLE outbox_event DROP COLUMN IF EXISTS store_id;
ALTER TABLE ifood_event DROP COLUMN IF EXISTS store_id;
ALTER TABLE ifood_state DROP COLUMN IF EXISTS store_id;
ALTER TABLE customer_address DROP COLUMN IF EXISTS store_id;
ALTER TABLE geocoding_cache DROP COLUMN IF EXISTS store_id;
ALTER TABLE whatsapp_connection DROP COLUMN IF EXISTS store_id;
ALTER TABLE whatsapp_conversation DROP COLUMN IF EXISTS store_id;

-- 4) Tabela stores (junto com as colunas Pagar.me: pagarme_recipient_id,
--    pagarme_status, split_platform_percentage)
DROP INDEX IF EXISTS idx_stores_slug;
DROP TABLE IF EXISTS stores;
