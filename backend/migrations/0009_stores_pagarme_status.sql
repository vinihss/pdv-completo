-- ============================================================
-- 0009_stores_pagarme_status — coluna já referenciada pelo schema
-- (stores.pagarme_status, default 'not_configured') mas ausente no
-- 0008_stores_and_store_id.sql. Sem ela, qualquer SELECT de stores
-- via Drizzle falha com "column does not exist" (500).
-- Idempotente.
-- ============================================================

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS pagarme_status TEXT NOT NULL DEFAULT 'not_configured';
