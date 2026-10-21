-- FASE 1b do workstream B: a coluna `tenant_id` vira OBRIGATÓRIA e as FKs
-- passam a ser COMPOSTAS.
--
-- POR QUE AS FKs COMPOSTAS
-- --------------------------
-- A FK simples (`order_item.order_id → order.id`) não sabe de loja: uma
-- linha da loja A pode apontar para a comanda da loja B, e nada impede. As
-- policies do RLS (Fase 2) não fecham isso — a verificação de FK no
-- Postgres ignora o RLS (a linha referenciada é vista pelo catálogo do
-- sistema, não pela policy da sessão).
--
-- A FK composta (`order_item(order_id, tenant_id) → order(id, tenant_id)`)
-- é o que trava: para a referência valer, a linha filha tem que ser do
-- MESMO tenant da linha mãe. E ela exige `UNIQUE (id, tenant_id)` na
-- tabela mãe — que é o índice que a policy também usa.
--
-- O QUE ESTE ARQUIVO FAZ
-- ----------------------
--  1. `UNIQUE (id, tenant_id)` nas tabelas que são pai de uma FK composta.
--  2. Troca as 45 FKs simples pela versão COMPOSTA.
--  3. `tenant_id` NOT NULL nas 30 tabelas de negócio.
--
-- A COLUNA PREENCHIDA
-- --------------------
-- A coluna é preenchida pelo trigger da `0013` (a partir do
-- `app.tenant_id` que o pool carrega no startup packet). O `NOT NULL`
-- abaixo é o que cobra quem escreve SEM contexto — e a mensagem do erro
-- (`null value in column "tenant_id"`) é o aviso de que falta o
-- `app.tenant_id`.
--
-- As FKs para as tabelas de CONTROLE (`account`, `account_identity`,
-- `auth_session`, `password_reset`) continuam simples: quem referencia
-- uma conta global não é um dado de loja.

-- ---------------------------------------------------------------------
-- 1. As FKs compostas (DROP primeiro)
-- ---------------------------------------------------------------------
-- O DROP vem ANTES do `UNIQUE (id, tenant_id)`: a FK depende desse
-- constraint, e o Postgres não deixa remover um constraint que tem
-- dependentes (sem CASCADE).
--
-- A regra de `ON DELETE`/`ON UPDATE` é a MESMA da FK simples que ela
-- substitui — trocar `ON DELETE SET NULL` pelo default (NO ACTION) muda
-- o comportamento do app (apagar um entregador passaria a falhar em vez
-- de deixar a entrega sem entregador).

ALTER TABLE "alert" DROP CONSTRAINT IF EXISTS "alert_order_id_fkey";
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_order_id_fkey";
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_user_id_fkey";
ALTER TABLE "cash_drawer" DROP CONSTRAINT IF EXISTS "cash_drawer_closed_by_fkey";
ALTER TABLE "cash_drawer" DROP CONSTRAINT IF EXISTS "cash_drawer_closing_approved_by_fkey";
ALTER TABLE "cash_drawer" DROP CONSTRAINT IF EXISTS "cash_drawer_opened_by_fkey";
ALTER TABLE "cash_drawer_movement" DROP CONSTRAINT IF EXISTS "cash_drawer_movement_created_by_fkey";
ALTER TABLE "cash_drawer_movement" DROP CONSTRAINT IF EXISTS "cash_drawer_movement_drawer_id_fkey";
ALTER TABLE "cash_drawer_movement" DROP CONSTRAINT IF EXISTS "cash_drawer_movement_ref_order_id_fkey";
ALTER TABLE "courier_location" DROP CONSTRAINT IF EXISTS "courier_location_courier_id_fkey";
ALTER TABLE "courier_location" DROP CONSTRAINT IF EXISTS "courier_location_region_id_fkey";
ALTER TABLE "customer_address" DROP CONSTRAINT IF EXISTS "customer_address_customer_id_fkey";
ALTER TABLE "delivery" DROP CONSTRAINT IF EXISTS "delivery_courier_id_fkey";
ALTER TABLE "delivery" DROP CONSTRAINT IF EXISTS "delivery_order_id_fkey";
ALTER TABLE "delivery" DROP CONSTRAINT IF EXISTS "delivery_region_id_fkey";
ALTER TABLE "delivery_region_route" DROP CONSTRAINT IF EXISTS "delivery_region_route_region_id_fkey";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_customer_id_fkey";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_payment_confirmed_by_fkey";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_table_id_fkey";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_waiter_id_fkey";
ALTER TABLE "order_item" DROP CONSTRAINT IF EXISTS "order_item_created_by_fkey";
ALTER TABLE "order_item" DROP CONSTRAINT IF EXISTS "order_item_order_id_fkey";
ALTER TABLE "order_item" DROP CONSTRAINT IF EXISTS "order_item_product_id_fkey";
ALTER TABLE "order_payment" DROP CONSTRAINT IF EXISTS "order_payment_confirmed_by_fkey1";
ALTER TABLE "order_payment" DROP CONSTRAINT IF EXISTS "order_payment_created_by_fkey";
ALTER TABLE "order_payment" DROP CONSTRAINT IF EXISTS "order_payment_order_id_fkey";
ALTER TABLE "order_refund" DROP CONSTRAINT IF EXISTS "order_refund_order_id_fkey";
ALTER TABLE "order_refund" DROP CONSTRAINT IF EXISTS "order_refund_order_payment_id_fkey";
ALTER TABLE "order_refund" DROP CONSTRAINT IF EXISTS "order_refund_requested_by_fkey";
ALTER TABLE "product" DROP CONSTRAINT IF EXISTS "product_category_id_fkey";
ALTER TABLE "product" DROP CONSTRAINT IF EXISTS "product_kitchen_group_id_fkey";
ALTER TABLE "provisioning_key" DROP CONSTRAINT IF EXISTS "provisioning_key_created_by_fkey";
ALTER TABLE "provisioning_key" DROP CONSTRAINT IF EXISTS "provisioning_key_user_id_fkey";
ALTER TABLE "purchase" DROP CONSTRAINT IF EXISTS "purchase_created_by_fkey";
ALTER TABLE "purchase" DROP CONSTRAINT IF EXISTS "purchase_supplier_id_fkey";
ALTER TABLE "purchase_item" DROP CONSTRAINT IF EXISTS "purchase_item_created_by_fkey";
ALTER TABLE "purchase_item" DROP CONSTRAINT IF EXISTS "purchase_item_product_id_fkey";
ALTER TABLE "purchase_item" DROP CONSTRAINT IF EXISTS "purchase_item_purchase_id_fkey";
ALTER TABLE "stock_movement" DROP CONSTRAINT IF EXISTS "stock_movement_created_by_fkey";
ALTER TABLE "stock_movement" DROP CONSTRAINT IF EXISTS "stock_movement_order_id_fkey";
ALTER TABLE "stock_movement" DROP CONSTRAINT IF EXISTS "stock_movement_order_item_id_fkey";
ALTER TABLE "stock_movement" DROP CONSTRAINT IF EXISTS "stock_movement_product_id_fkey";
ALTER TABLE "stock_movement" DROP CONSTRAINT IF EXISTS "stock_movement_purchase_item_id_fkey";
ALTER TABLE "user_device" DROP CONSTRAINT IF EXISTS "user_device_provisioning_key_id_fkey";
ALTER TABLE "user_device" DROP CONSTRAINT IF EXISTS "user_device_user_id_fkey";

-- ---------------------------------------------------------------------
-- 2. UNIQUE (id, tenant_id) nas tabelas que são pai
-- ---------------------------------------------------------------------
ALTER TABLE "cash_drawer" DROP CONSTRAINT IF EXISTS uq_cash_drawer_id_tenant;
ALTER TABLE "cash_drawer" ADD CONSTRAINT uq_cash_drawer_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "category" DROP CONSTRAINT IF EXISTS uq_category_id_tenant;
ALTER TABLE "category" ADD CONSTRAINT uq_category_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "customer" DROP CONSTRAINT IF EXISTS uq_customer_id_tenant;
ALTER TABLE "customer" ADD CONSTRAINT uq_customer_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "delivery_region" DROP CONSTRAINT IF EXISTS uq_delivery_region_id_tenant;
ALTER TABLE "delivery_region" ADD CONSTRAINT uq_delivery_region_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "kitchen_group" DROP CONSTRAINT IF EXISTS uq_kitchen_group_id_tenant;
ALTER TABLE "kitchen_group" ADD CONSTRAINT uq_kitchen_group_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS uq_order_id_tenant;
ALTER TABLE "order" ADD CONSTRAINT uq_order_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "order_item" DROP CONSTRAINT IF EXISTS uq_order_item_id_tenant;
ALTER TABLE "order_item" ADD CONSTRAINT uq_order_item_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "order_payment" DROP CONSTRAINT IF EXISTS uq_order_payment_id_tenant;
ALTER TABLE "order_payment" ADD CONSTRAINT uq_order_payment_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "product" DROP CONSTRAINT IF EXISTS uq_product_id_tenant;
ALTER TABLE "product" ADD CONSTRAINT uq_product_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "provisioning_key" DROP CONSTRAINT IF EXISTS uq_provisioning_key_id_tenant;
ALTER TABLE "provisioning_key" ADD CONSTRAINT uq_provisioning_key_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "purchase" DROP CONSTRAINT IF EXISTS uq_purchase_id_tenant;
ALTER TABLE "purchase" ADD CONSTRAINT uq_purchase_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "purchase_item" DROP CONSTRAINT IF EXISTS uq_purchase_item_id_tenant;
ALTER TABLE "purchase_item" ADD CONSTRAINT uq_purchase_item_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "restaurant_table" DROP CONSTRAINT IF EXISTS uq_restaurant_table_id_tenant;
ALTER TABLE "restaurant_table" ADD CONSTRAINT uq_restaurant_table_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "supplier" DROP CONSTRAINT IF EXISTS uq_supplier_id_tenant;
ALTER TABLE "supplier" ADD CONSTRAINT uq_supplier_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS uq_user_id_tenant;
ALTER TABLE "user" ADD CONSTRAINT uq_user_id_tenant UNIQUE (id, tenant_id);

-- ---------------------------------------------------------------------
-- 3. As FKs compostas (com a regra original)
-- ---------------------------------------------------------------------
ALTER TABLE "alert" ADD CONSTRAINT "alert_order_id_fkey"
  FOREIGN KEY (order_id, tenant_id) REFERENCES "order" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_order_id_fkey"
  FOREIGN KEY (order_id, tenant_id) REFERENCES "order" (id, tenant_id)
;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey"
  FOREIGN KEY (user_id, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "cash_drawer" ADD CONSTRAINT "cash_drawer_closed_by_fkey"
  FOREIGN KEY (closed_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "cash_drawer" ADD CONSTRAINT "cash_drawer_closing_approved_by_fkey"
  FOREIGN KEY (closing_approved_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "cash_drawer" ADD CONSTRAINT "cash_drawer_opened_by_fkey"
  FOREIGN KEY (opened_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "cash_drawer_movement" ADD CONSTRAINT "cash_drawer_movement_created_by_fkey"
  FOREIGN KEY (created_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "cash_drawer_movement" ADD CONSTRAINT "cash_drawer_movement_drawer_id_fkey"
  FOREIGN KEY (drawer_id, tenant_id) REFERENCES "cash_drawer" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "cash_drawer_movement" ADD CONSTRAINT "cash_drawer_movement_ref_order_id_fkey"
  FOREIGN KEY (ref_order_id, tenant_id) REFERENCES "order" (id, tenant_id)
;
ALTER TABLE "courier_location" ADD CONSTRAINT "courier_location_courier_id_fkey"
  FOREIGN KEY (courier_id, tenant_id) REFERENCES "user" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "courier_location" ADD CONSTRAINT "courier_location_region_id_fkey"
  FOREIGN KEY (region_id, tenant_id) REFERENCES "delivery_region" (id, tenant_id)
  ON DELETE SET NULL (region_id)
;
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_customer_id_fkey"
  FOREIGN KEY (customer_id, tenant_id) REFERENCES "customer" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_courier_id_fkey"
  FOREIGN KEY (courier_id, tenant_id) REFERENCES "user" (id, tenant_id)
  ON DELETE SET NULL (courier_id)
;
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_order_id_fkey"
  FOREIGN KEY (order_id, tenant_id) REFERENCES "order" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_region_id_fkey"
  FOREIGN KEY (region_id, tenant_id) REFERENCES "delivery_region" (id, tenant_id)
  ON DELETE SET NULL (region_id)
;
ALTER TABLE "delivery_region_route" ADD CONSTRAINT "delivery_region_route_region_id_fkey"
  FOREIGN KEY (region_id, tenant_id) REFERENCES "delivery_region" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "order" ADD CONSTRAINT "order_customer_id_fkey"
  FOREIGN KEY (customer_id, tenant_id) REFERENCES "customer" (id, tenant_id)
  ON DELETE SET NULL (customer_id)
;
ALTER TABLE "order" ADD CONSTRAINT "order_payment_confirmed_by_fkey"
  FOREIGN KEY (payment_confirmed_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "order" ADD CONSTRAINT "order_table_id_fkey"
  FOREIGN KEY (table_id, tenant_id) REFERENCES "restaurant_table" (id, tenant_id)
  ON DELETE RESTRICT
;
ALTER TABLE "order" ADD CONSTRAINT "order_waiter_id_fkey"
  FOREIGN KEY (waiter_id, tenant_id) REFERENCES "user" (id, tenant_id)
  ON DELETE RESTRICT
;
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_created_by_fkey"
  FOREIGN KEY (created_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_fkey"
  FOREIGN KEY (order_id, tenant_id) REFERENCES "order" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_product_id_fkey"
  FOREIGN KEY (product_id, tenant_id) REFERENCES "product" (id, tenant_id)
  ON DELETE RESTRICT
;
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_confirmed_by_fkey1"
  FOREIGN KEY (confirmed_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_created_by_fkey"
  FOREIGN KEY (created_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_order_id_fkey"
  FOREIGN KEY (order_id, tenant_id) REFERENCES "order" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "order_refund" ADD CONSTRAINT "order_refund_order_id_fkey"
  FOREIGN KEY (order_id, tenant_id) REFERENCES "order" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "order_refund" ADD CONSTRAINT "order_refund_order_payment_id_fkey"
  FOREIGN KEY (order_payment_id, tenant_id) REFERENCES "order_payment" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "order_refund" ADD CONSTRAINT "order_refund_requested_by_fkey"
  FOREIGN KEY (requested_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_fkey"
  FOREIGN KEY (category_id, tenant_id) REFERENCES "category" (id, tenant_id)
  ON DELETE SET NULL (category_id)
;
ALTER TABLE "product" ADD CONSTRAINT "product_kitchen_group_id_fkey"
  FOREIGN KEY (kitchen_group_id, tenant_id) REFERENCES "kitchen_group" (id, tenant_id)
  ON DELETE SET NULL (kitchen_group_id)
;
ALTER TABLE "provisioning_key" ADD CONSTRAINT "provisioning_key_created_by_fkey"
  FOREIGN KEY (created_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "provisioning_key" ADD CONSTRAINT "provisioning_key_user_id_fkey"
  FOREIGN KEY (user_id, tenant_id) REFERENCES "user" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_created_by_fkey"
  FOREIGN KEY (created_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_supplier_id_fkey"
  FOREIGN KEY (supplier_id, tenant_id) REFERENCES "supplier" (id, tenant_id)
  ON DELETE SET NULL (supplier_id)
;
ALTER TABLE "purchase_item" ADD CONSTRAINT "purchase_item_created_by_fkey"
  FOREIGN KEY (created_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "purchase_item" ADD CONSTRAINT "purchase_item_product_id_fkey"
  FOREIGN KEY (product_id, tenant_id) REFERENCES "product" (id, tenant_id)
  ON DELETE RESTRICT
;
ALTER TABLE "purchase_item" ADD CONSTRAINT "purchase_item_purchase_id_fkey"
  FOREIGN KEY (purchase_id, tenant_id) REFERENCES "purchase" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_created_by_fkey"
  FOREIGN KEY (created_by, tenant_id) REFERENCES "user" (id, tenant_id)
;
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_order_id_fkey"
  FOREIGN KEY (order_id, tenant_id) REFERENCES "order" (id, tenant_id)
  ON DELETE SET NULL (order_id)
;
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_order_item_id_fkey"
  FOREIGN KEY (order_item_id, tenant_id) REFERENCES "order_item" (id, tenant_id)
  ON DELETE SET NULL (order_item_id)
;
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_product_id_fkey"
  FOREIGN KEY (product_id, tenant_id) REFERENCES "product" (id, tenant_id)
  ON DELETE CASCADE
;
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_purchase_item_id_fkey"
  FOREIGN KEY (purchase_item_id, tenant_id) REFERENCES "purchase_item" (id, tenant_id)
  ON DELETE SET NULL (purchase_item_id)
;
ALTER TABLE "user_device" ADD CONSTRAINT "user_device_provisioning_key_id_fkey"
  FOREIGN KEY (provisioning_key_id, tenant_id) REFERENCES "provisioning_key" (id, tenant_id)
;
ALTER TABLE "user_device" ADD CONSTRAINT "user_device_user_id_fkey"
  FOREIGN KEY (user_id, tenant_id) REFERENCES "user" (id, tenant_id)
  ON DELETE CASCADE
;

-- ---------------------------------------------------------------------
-- 4. A coluna é obrigatória
-- ---------------------------------------------------------------------
ALTER TABLE "alert" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "audit_log" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "cash_drawer" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "cash_drawer_movement" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "category" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "courier_location" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "customer" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "customer_address" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "customer_cart" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "delivery" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "delivery_region" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "delivery_region_route" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "geocoding_cache" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "idempotency_key" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "kitchen_group" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "order" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "order_item" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "order_payment" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "order_refund" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "outbox_event" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "product" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "provisioning_key" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "purchase" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "purchase_item" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "restaurant_table" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "stock_movement" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "store_settings" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "supplier" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "user" ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE "user_device" ALTER COLUMN tenant_id SET NOT NULL;

