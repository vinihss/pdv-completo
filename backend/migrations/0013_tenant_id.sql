-- FASE 1 do workstream B (multi-tenant por LINHA): a coluna `tenant_id`.
--
-- A barreira de RLS (Fase 2) compara a linha com `app.tenant_id`; esta
-- migration cria a coluna que ela vai filtrar — e a preenche sozinha, para
-- que o código do app não precise saber dela (38 arquivos escrevem em
-- tabelas de negócio; nenhum deles pode esquecer o tenant).
--
-- O QUE ESTE ARQUIVO FAZ
-- ----------------------
--  1. `tenant_id uuid` nas 32 tabelas de negócio, com FK para
--     `public.tenant(id)` e índice.
--  2. Um TRIGGER que preenche a coluna a partir de `app.tenant_id`
--     (o contexto que a transação já carrega — `set_config` no UoW).
--     Sem contexto, a coluna fica como veio: o NOT NULL da Fase 1b cobra.
--  3. O BACKFILL: o default para as tabelas sem pai, e o tenant DO
--     PAI para as demais (uma linha da loja A não pode apontar para a
--     loja B — é isso que a FK composta da Fase 1b vai travar).
--
-- O QUE NÃO MUDA
-- ---------------
-- O roteamento (schema-por-tenant), o app (nenhum arquivo muda) e o dado
-- (a coluna é preenchida, nada é apagado). A coluna nasce NULLABLE: o
-- NOT NULL e as FKs compostas são da migration seguinte (`0014`), que só
-- faz sentido depois de o backfill estar conferido.
--
-- As tabelas de CONTROLE (`public.tenant`, `public.account`,
-- `public.account_identity`, `public.auth_session`,
-- `public.password_reset`) e a `spatial_ref_sys` do PostGIS ficam de
-- fora: são plano de controle, não dado de loja (e não entram nas policies).
--
-- O índice e o backfill são de tabela cheia: com o volume de hoje (sem
-- cliente real) é instantâneo. Num banco grande, este arquivo precisaria
-- de `CREATE INDEX CONCURRENTLY` — que não roda dentro da transação do
-- runner — e de um plano de cutover próprio.

-- ---------------------------------------------------------------------
-- 1. A coluna, o índice e o trigger
-- ---------------------------------------------------------------------
ALTER TABLE "alert" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "cash_drawer" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "cash_drawer_movement" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "category" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "courier_location" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "customer" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "customer_address" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "customer_cart" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "delivery" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "delivery_region" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "delivery_region_route" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "geocoding_cache" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "idempotency_key" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "kitchen_group" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "order_item" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "order_payment" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "order_refund" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "product" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "provisioning_key" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "purchase" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "purchase_item" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "restaurant_table" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "stock_movement" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "supplier" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);
ALTER TABLE "user_device" ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenant(id);

CREATE INDEX IF NOT EXISTS idx_alert_tenant_id ON "alert" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id ON "audit_log" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_tenant_id ON "cash_drawer" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_movement_tenant_id ON "cash_drawer_movement" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_category_tenant_id ON "category" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_courier_location_tenant_id ON "courier_location" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_tenant_id ON "customer" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_address_tenant_id ON "customer_address" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_cart_tenant_id ON "customer_cart" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_tenant_id ON "delivery" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_region_tenant_id ON "delivery_region" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_region_route_tenant_id ON "delivery_region_route" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_geocoding_cache_tenant_id ON "geocoding_cache" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_key_tenant_id ON "idempotency_key" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_kitchen_group_tenant_id ON "kitchen_group" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_tenant_id ON "order" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_item_tenant_id ON "order_item" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_payment_tenant_id ON "order_payment" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_refund_tenant_id ON "order_refund" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_outbox_event_tenant_id ON "outbox_event" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_product_tenant_id ON "product" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_provisioning_key_tenant_id ON "provisioning_key" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_tenant_id ON "purchase" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_item_tenant_id ON "purchase_item" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_table_tenant_id ON "restaurant_table" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_movement_tenant_id ON "stock_movement" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_store_settings_tenant_id ON "store_settings" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_supplier_tenant_id ON "supplier" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_tenant_id ON "user" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_device_tenant_id ON "user_device" (tenant_id);

-- O trigger: `NEW.tenant_id` NULL + contexto na sessão → preenche com o
-- contexto. O `EXCEPTION` cobre o GUC ausente ou não-uuid (aí o NOT NULL
-- da Fase 1b é quem reclama, com mensagem clara).
CREATE OR REPLACE FUNCTION public.pdvv_fill_tenant_id() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    DECLARE
      contexto text;
    BEGIN
      contexto := current_setting('app.tenant_id', true);
      IF contexto IS NOT NULL AND contexto <> '' THEN
        NEW.tenant_id := contexto::uuid;
      END IF;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_alert_fill_tenant_id ON "alert";
CREATE TRIGGER trg_alert_fill_tenant_id BEFORE INSERT ON "alert" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_audit_log_fill_tenant_id ON "audit_log";
CREATE TRIGGER trg_audit_log_fill_tenant_id BEFORE INSERT ON "audit_log" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_cash_drawer_fill_tenant_id ON "cash_drawer";
CREATE TRIGGER trg_cash_drawer_fill_tenant_id BEFORE INSERT ON "cash_drawer" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_cash_drawer_movement_fill_tenant_id ON "cash_drawer_movement";
CREATE TRIGGER trg_cash_drawer_movement_fill_tenant_id BEFORE INSERT ON "cash_drawer_movement" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_category_fill_tenant_id ON "category";
CREATE TRIGGER trg_category_fill_tenant_id BEFORE INSERT ON "category" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_courier_location_fill_tenant_id ON "courier_location";
CREATE TRIGGER trg_courier_location_fill_tenant_id BEFORE INSERT ON "courier_location" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_customer_fill_tenant_id ON "customer";
CREATE TRIGGER trg_customer_fill_tenant_id BEFORE INSERT ON "customer" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_customer_address_fill_tenant_id ON "customer_address";
CREATE TRIGGER trg_customer_address_fill_tenant_id BEFORE INSERT ON "customer_address" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_customer_cart_fill_tenant_id ON "customer_cart";
CREATE TRIGGER trg_customer_cart_fill_tenant_id BEFORE INSERT ON "customer_cart" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_delivery_fill_tenant_id ON "delivery";
CREATE TRIGGER trg_delivery_fill_tenant_id BEFORE INSERT ON "delivery" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_delivery_region_fill_tenant_id ON "delivery_region";
CREATE TRIGGER trg_delivery_region_fill_tenant_id BEFORE INSERT ON "delivery_region" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_delivery_region_route_fill_tenant_id ON "delivery_region_route";
CREATE TRIGGER trg_delivery_region_route_fill_tenant_id BEFORE INSERT ON "delivery_region_route" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_geocoding_cache_fill_tenant_id ON "geocoding_cache";
CREATE TRIGGER trg_geocoding_cache_fill_tenant_id BEFORE INSERT ON "geocoding_cache" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_idempotency_key_fill_tenant_id ON "idempotency_key";
CREATE TRIGGER trg_idempotency_key_fill_tenant_id BEFORE INSERT ON "idempotency_key" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_kitchen_group_fill_tenant_id ON "kitchen_group";
CREATE TRIGGER trg_kitchen_group_fill_tenant_id BEFORE INSERT ON "kitchen_group" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_order_fill_tenant_id ON "order";
CREATE TRIGGER trg_order_fill_tenant_id BEFORE INSERT ON "order" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_order_item_fill_tenant_id ON "order_item";
CREATE TRIGGER trg_order_item_fill_tenant_id BEFORE INSERT ON "order_item" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_order_payment_fill_tenant_id ON "order_payment";
CREATE TRIGGER trg_order_payment_fill_tenant_id BEFORE INSERT ON "order_payment" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_order_refund_fill_tenant_id ON "order_refund";
CREATE TRIGGER trg_order_refund_fill_tenant_id BEFORE INSERT ON "order_refund" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_outbox_event_fill_tenant_id ON "outbox_event";
CREATE TRIGGER trg_outbox_event_fill_tenant_id BEFORE INSERT ON "outbox_event" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_product_fill_tenant_id ON "product";
CREATE TRIGGER trg_product_fill_tenant_id BEFORE INSERT ON "product" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_provisioning_key_fill_tenant_id ON "provisioning_key";
CREATE TRIGGER trg_provisioning_key_fill_tenant_id BEFORE INSERT ON "provisioning_key" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_purchase_fill_tenant_id ON "purchase";
CREATE TRIGGER trg_purchase_fill_tenant_id BEFORE INSERT ON "purchase" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_purchase_item_fill_tenant_id ON "purchase_item";
CREATE TRIGGER trg_purchase_item_fill_tenant_id BEFORE INSERT ON "purchase_item" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_restaurant_table_fill_tenant_id ON "restaurant_table";
CREATE TRIGGER trg_restaurant_table_fill_tenant_id BEFORE INSERT ON "restaurant_table" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_stock_movement_fill_tenant_id ON "stock_movement";
CREATE TRIGGER trg_stock_movement_fill_tenant_id BEFORE INSERT ON "stock_movement" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_store_settings_fill_tenant_id ON "store_settings";
CREATE TRIGGER trg_store_settings_fill_tenant_id BEFORE INSERT ON "store_settings" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_supplier_fill_tenant_id ON "supplier";
CREATE TRIGGER trg_supplier_fill_tenant_id BEFORE INSERT ON "supplier" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_user_fill_tenant_id ON "user";
CREATE TRIGGER trg_user_fill_tenant_id BEFORE INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();
DROP TRIGGER IF EXISTS trg_user_device_fill_tenant_id ON "user_device";
CREATE TRIGGER trg_user_device_fill_tenant_id BEFORE INSERT ON "user_device" FOR EACH ROW EXECUTE FUNCTION public.pdvv_fill_tenant_id();

-- ---------------------------------------------------------------------
-- 2. O backfill
-- ---------------------------------------------------------------------
-- O default (`00000000-0000-0000-0000-000000000001`) é o dono do
-- schema `public` — o mesmo id da linha em `public.tenant` (migration de
-- registry `0003_tenant_id.sql`).

-- 2a. As tabelas SEM pai: o default direto.

UPDATE "category" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "customer" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "customer_cart" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "delivery_region" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "geocoding_cache" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "idempotency_key" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "kitchen_group" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "outbox_event" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "restaurant_table" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "store_settings" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "supplier" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE "user" SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;

-- 2b. As tabelas COM pai: o tenant do pai (na ordem em que o pai já foi
-- preenchido — por isso a ordem topológica acima).

UPDATE "cash_drawer" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."closed_by" = p.id AND f.tenant_id IS NULL;
UPDATE "cash_drawer" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."opened_by" = p.id AND f.tenant_id IS NULL;
UPDATE "cash_drawer" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."closing_approved_by" = p.id AND f.tenant_id IS NULL;

UPDATE "courier_location" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."courier_id" = p.id AND f.tenant_id IS NULL;
UPDATE "courier_location" AS f SET tenant_id = p.tenant_id
  FROM "delivery_region" AS p
 WHERE f."region_id" = p.id AND f.tenant_id IS NULL;

UPDATE "customer_address" AS f SET tenant_id = p.tenant_id
  FROM "customer" AS p
 WHERE f."customer_id" = p.id AND f.tenant_id IS NULL;

UPDATE "delivery_region_route" AS f SET tenant_id = p.tenant_id
  FROM "delivery_region" AS p
 WHERE f."region_id" = p.id AND f.tenant_id IS NULL;

UPDATE "order" AS f SET tenant_id = p.tenant_id
  FROM "customer" AS p
 WHERE f."customer_id" = p.id AND f.tenant_id IS NULL;
UPDATE "order" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."payment_confirmed_by" = p.id AND f.tenant_id IS NULL;
UPDATE "order" AS f SET tenant_id = p.tenant_id
  FROM "restaurant_table" AS p
 WHERE f."table_id" = p.id AND f.tenant_id IS NULL;
UPDATE "order" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."waiter_id" = p.id AND f.tenant_id IS NULL;

UPDATE "product" AS f SET tenant_id = p.tenant_id
  FROM "category" AS p
 WHERE f."category_id" = p.id AND f.tenant_id IS NULL;
UPDATE "product" AS f SET tenant_id = p.tenant_id
  FROM "kitchen_group" AS p
 WHERE f."kitchen_group_id" = p.id AND f.tenant_id IS NULL;

UPDATE "provisioning_key" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."created_by" = p.id AND f.tenant_id IS NULL;
UPDATE "provisioning_key" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."user_id" = p.id AND f.tenant_id IS NULL;

UPDATE "purchase" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."created_by" = p.id AND f.tenant_id IS NULL;
UPDATE "purchase" AS f SET tenant_id = p.tenant_id
  FROM "supplier" AS p
 WHERE f."supplier_id" = p.id AND f.tenant_id IS NULL;

UPDATE "alert" AS f SET tenant_id = p.tenant_id
  FROM "order" AS p
 WHERE f."order_id" = p.id AND f.tenant_id IS NULL;

UPDATE "audit_log" AS f SET tenant_id = p.tenant_id
  FROM "order" AS p
 WHERE f."order_id" = p.id AND f.tenant_id IS NULL;
UPDATE "audit_log" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."user_id" = p.id AND f.tenant_id IS NULL;

UPDATE "cash_drawer_movement" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."created_by" = p.id AND f.tenant_id IS NULL;
UPDATE "cash_drawer_movement" AS f SET tenant_id = p.tenant_id
  FROM "cash_drawer" AS p
 WHERE f."drawer_id" = p.id AND f.tenant_id IS NULL;
UPDATE "cash_drawer_movement" AS f SET tenant_id = p.tenant_id
  FROM "order" AS p
 WHERE f."ref_order_id" = p.id AND f.tenant_id IS NULL;

UPDATE "delivery" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."courier_id" = p.id AND f.tenant_id IS NULL;
UPDATE "delivery" AS f SET tenant_id = p.tenant_id
  FROM "order" AS p
 WHERE f."order_id" = p.id AND f.tenant_id IS NULL;
UPDATE "delivery" AS f SET tenant_id = p.tenant_id
  FROM "delivery_region" AS p
 WHERE f."region_id" = p.id AND f.tenant_id IS NULL;

UPDATE "order_item" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."created_by" = p.id AND f.tenant_id IS NULL;
UPDATE "order_item" AS f SET tenant_id = p.tenant_id
  FROM "order" AS p
 WHERE f."order_id" = p.id AND f.tenant_id IS NULL;
UPDATE "order_item" AS f SET tenant_id = p.tenant_id
  FROM "product" AS p
 WHERE f."product_id" = p.id AND f.tenant_id IS NULL;

UPDATE "order_payment" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."confirmed_by" = p.id AND f.tenant_id IS NULL;
UPDATE "order_payment" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."created_by" = p.id AND f.tenant_id IS NULL;
UPDATE "order_payment" AS f SET tenant_id = p.tenant_id
  FROM "order" AS p
 WHERE f."order_id" = p.id AND f.tenant_id IS NULL;

UPDATE "purchase_item" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."created_by" = p.id AND f.tenant_id IS NULL;
UPDATE "purchase_item" AS f SET tenant_id = p.tenant_id
  FROM "product" AS p
 WHERE f."product_id" = p.id AND f.tenant_id IS NULL;
UPDATE "purchase_item" AS f SET tenant_id = p.tenant_id
  FROM "purchase" AS p
 WHERE f."purchase_id" = p.id AND f.tenant_id IS NULL;

UPDATE "user_device" AS f SET tenant_id = p.tenant_id
  FROM "provisioning_key" AS p
 WHERE f."provisioning_key_id" = p.id AND f.tenant_id IS NULL;
UPDATE "user_device" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."user_id" = p.id AND f.tenant_id IS NULL;

UPDATE "order_refund" AS f SET tenant_id = p.tenant_id
  FROM "order" AS p
 WHERE f."order_id" = p.id AND f.tenant_id IS NULL;
UPDATE "order_refund" AS f SET tenant_id = p.tenant_id
  FROM "order_payment" AS p
 WHERE f."order_payment_id" = p.id AND f.tenant_id IS NULL;
UPDATE "order_refund" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."requested_by" = p.id AND f.tenant_id IS NULL;

UPDATE "stock_movement" AS f SET tenant_id = p.tenant_id
  FROM "user" AS p
 WHERE f."created_by" = p.id AND f.tenant_id IS NULL;
UPDATE "stock_movement" AS f SET tenant_id = p.tenant_id
  FROM "order" AS p
 WHERE f."order_id" = p.id AND f.tenant_id IS NULL;
UPDATE "stock_movement" AS f SET tenant_id = p.tenant_id
  FROM "order_item" AS p
 WHERE f."order_item_id" = p.id AND f.tenant_id IS NULL;
UPDATE "stock_movement" AS f SET tenant_id = p.tenant_id
  FROM "product" AS p
 WHERE f."product_id" = p.id AND f.tenant_id IS NULL;
UPDATE "stock_movement" AS f SET tenant_id = p.tenant_id
  FROM "purchase_item" AS p
 WHERE f."purchase_item_id" = p.id AND f.tenant_id IS NULL;

