-- 0016_tenant_composite_pk.sql - a chave primaria passa a ser COMPOSTA
--
-- POR QUE
-- -------
-- A Fase 3 tira o schema-por-loja: todas as lojas passam a morar no mesmo
-- schema (`public`), separadas so pela coluna `tenant_id` (o RLS da Fase 2 e
-- a barreira). No schema unico, o `id` deixa de ser globalmente unico: o
-- `store_settings` e o singleton `'singleton'` em TODA loja, e o seed usa ids
-- fixos (`system`, as categorias, as mesas...). Com a PK em `id` sozinho, a
-- segunda loja colide com a primeira - e o `ON CONFLICT` do seed sobrescreve
-- a marca da loja anterior em vez de falhar.
--
-- A PK passa a ser `(tenant_id, <chave>)`: o id e unico DENTRO da loja, e a
-- identidade global do dado passa a ser o par. E o mesmo desenho que o
-- `docs/28-multitenant-row-level.md` §3.2 descreve ("no modelo por linha ela
-- vira `(tenant_id, id)`").
--
-- O QUE ESTA MIGRATION FAZ
-- ------------------------
--  1. As PKs das 30 tabelas de negocio viram `(tenant_id, <chave>)`.
--  2. Os dois UNIQUEs que sao de loja (`delivery.order_id`,
--     `restaurant_table.number`) viram compostos.
--  3. Os dados que ainda estejam em schemas de loja sao COPIADOS para
--     `public` com o `tenant_id` da loja (o `tenant_id` das linhas antigas
--     aponta para o default - o backfill da 0013 nao conhecia o dono do
--     schema). O schema antigo NAO e dropado aqui: quem faz isso e a Fase 3
--     (o runtime ainda le o schema da loja ate a virada).
--
-- POR QUE A COPIA NAO QUEBRA NADA
-- -------------------------------
-- As FKs intra-loja JA sao compostas (a migration 0014 as recriou como
-- `(id, tenant_id)` -> `(id, tenant_id)`), entao trocar a PK nao invalida
-- nenhuma delas: elas referenciam o `UNIQUE (id, tenant_id)` que a 0014
-- criou, e ele continua de pe. As FKs que sobraram com coluna unica sao as
-- de controle de plano (`tenant_id -> public.tenant`, `account_id ->
-- public.account`) - tabelas que nao entram aqui.
--
-- O ROLLOUT
-- ---------
-- Esta migration e a "expand" do par:
--   0016 (aqui)     -> o schema `public` passa a aceitar duas lojas; o dado
--                       antigo e copiado; o runtime ainda le o schema da loja.
--   Fase 3 (codigo) -> o runtime passa a ler `public` e o cache a separar por
--                       `tenant_id`.
--   0017 (depois)    -> os schemas de loja sao dropados.
-- A ordem importa: entre a 0016 e a virada do runtime, os dois caminhos
-- convivem (o `public` tem a copia, o schema antigo tem o original).
--
-- A CÓPIA PRECISA DE `BYPASSRLS`
-- -------------------------------
-- A cópia roda no papel do DONO. Com `FORCE ROW LEVEL SECURITY` (a 0015), o
-- dono das tabelas também é filtrado pela policy — e o dono sem `BYPASSRLS`
-- não enxergaria as linhas de outra loja. O papel das migrations precisa ser
-- superuser ou ter `BYPASSRLS` (a mesma exigência da 0015).


-- ---------------------------------------------------------------------------
-- 1. As PKs compostas
-- ---------------------------------------------------------------------------
-- O `DROP` vem antes do `ADD`: a PK antiga (`id`) impede o `ADD`.
-- As tabelas sem `tenant_id` (o registry `public.tenant` e as tabelas
-- globais de identidade) ficam de fora - elas sao de controle de plano.

ALTER TABLE "category" DROP CONSTRAINT IF EXISTS "category_pkey";
ALTER TABLE "category" ADD CONSTRAINT "category_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "customer" DROP CONSTRAINT IF EXISTS "customer_pkey";
ALTER TABLE "customer" ADD CONSTRAINT "customer_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "customer_cart" DROP CONSTRAINT IF EXISTS "customer_cart_pkey";
ALTER TABLE "customer_cart" ADD CONSTRAINT "customer_cart_pkey" PRIMARY KEY ("tenant_id", "phone");
ALTER TABLE "delivery_region" DROP CONSTRAINT IF EXISTS "delivery_region_pkey";
ALTER TABLE "delivery_region" ADD CONSTRAINT "delivery_region_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "geocoding_cache" DROP CONSTRAINT IF EXISTS "geocoding_cache_pkey";
ALTER TABLE "geocoding_cache" ADD CONSTRAINT "geocoding_cache_pkey" PRIMARY KEY ("tenant_id", "cache_key");
ALTER TABLE "idempotency_key" DROP CONSTRAINT IF EXISTS "idempotency_key_pkey";
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("tenant_id", "correlation_id");
ALTER TABLE "kitchen_group" DROP CONSTRAINT IF EXISTS "kitchen_group_pkey";
ALTER TABLE "kitchen_group" ADD CONSTRAINT "kitchen_group_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "outbox_event" DROP CONSTRAINT IF EXISTS "outbox_event_pkey";
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "restaurant_table" DROP CONSTRAINT IF EXISTS "restaurant_table_pkey";
ALTER TABLE "restaurant_table" ADD CONSTRAINT "restaurant_table_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "store_settings" DROP CONSTRAINT IF EXISTS "store_settings_pkey";
ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "supplier" DROP CONSTRAINT IF EXISTS "supplier_pkey";
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_pkey";
ALTER TABLE "user" ADD CONSTRAINT "user_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "cash_drawer" DROP CONSTRAINT IF EXISTS "cash_drawer_pkey";
ALTER TABLE "cash_drawer" ADD CONSTRAINT "cash_drawer_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "courier_location" DROP CONSTRAINT IF EXISTS "courier_location_pkey";
ALTER TABLE "courier_location" ADD CONSTRAINT "courier_location_pkey" PRIMARY KEY ("tenant_id", "courier_id");
ALTER TABLE "customer_address" DROP CONSTRAINT IF EXISTS "customer_address_pkey";
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "delivery_region_route" DROP CONSTRAINT IF EXISTS "delivery_region_route_pkey";
ALTER TABLE "delivery_region_route" ADD CONSTRAINT "delivery_region_route_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_pkey";
ALTER TABLE "order" ADD CONSTRAINT "order_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "product" DROP CONSTRAINT IF EXISTS "product_pkey";
ALTER TABLE "product" ADD CONSTRAINT "product_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "provisioning_key" DROP CONSTRAINT IF EXISTS "provisioning_key_pkey";
ALTER TABLE "provisioning_key" ADD CONSTRAINT "provisioning_key_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "purchase" DROP CONSTRAINT IF EXISTS "purchase_pkey";
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "alert" DROP CONSTRAINT IF EXISTS "alert_pkey";
ALTER TABLE "alert" ADD CONSTRAINT "alert_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_pkey";
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "cash_drawer_movement" DROP CONSTRAINT IF EXISTS "cash_drawer_movement_pkey";
ALTER TABLE "cash_drawer_movement" ADD CONSTRAINT "cash_drawer_movement_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "delivery" DROP CONSTRAINT IF EXISTS "delivery_pkey";
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "order_item" DROP CONSTRAINT IF EXISTS "order_item_pkey";
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "order_payment" DROP CONSTRAINT IF EXISTS "order_payment_pkey";
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "purchase_item" DROP CONSTRAINT IF EXISTS "purchase_item_pkey";
ALTER TABLE "purchase_item" ADD CONSTRAINT "purchase_item_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "user_device" DROP CONSTRAINT IF EXISTS "user_device_pkey";
ALTER TABLE "user_device" ADD CONSTRAINT "user_device_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "order_refund" DROP CONSTRAINT IF EXISTS "order_refund_pkey";
ALTER TABLE "order_refund" ADD CONSTRAINT "order_refund_pkey" PRIMARY KEY ("tenant_id", "id");
ALTER TABLE "stock_movement" DROP CONSTRAINT IF EXISTS "stock_movement_pkey";
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("tenant_id", "id");


-- ---------------------------------------------------------------------------
-- 2. Os UNIQUEs que sao de loja
-- ---------------------------------------------------------------------------
-- `delivery.order_id` e `restaurant_table.number` sao unicos DENTRO da loja
-- (duas lojas podem ter a comanda 1 e a mesa 1).

ALTER TABLE "delivery" DROP CONSTRAINT IF EXISTS "delivery_order_id_key";
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_order_id_key" UNIQUE ("tenant_id", "order_id");
ALTER TABLE "restaurant_table" DROP CONSTRAINT IF EXISTS "restaurant_table_number_key";
ALTER TABLE "restaurant_table" ADD CONSTRAINT "restaurant_table_number_key" UNIQUE ("tenant_id", "number");


-- ---------------------------------------------------------------------------
-- 3. A copia do dado que ainda estiver em schema de loja
-- ---------------------------------------------------------------------------
-- As lojas do registry que ainda tem o schema `tenant_*` (o modelo antigo)
-- tem o dado la. Ele e copiado para `public` com o `tenant_id` DA LOJA - o
-- `tenant_id` das linhas antigas aponta para o default (o backfill da 0013
-- nao conhecia o dono do schema), entao a copia SUBSTITUI o valor.
--
-- A ordem e topologica (o pai antes do filho): a FK composta do filho
-- (`tenant_id, pai_id`) so fecha se o pai ja estiver em `public`.
--
-- O schema antigo NAO e dropado aqui (a virada do runtime e a Fase 3).

DO $copia$
DECLARE
  loja RECORD;
BEGIN
  -- A cópia roda só no schema `public` (o destino). A mesma migration é
  -- aplicada nos schemas de loja do modelo ANTIGO (o runner as aplica lá
  -- também) — e lá não há o que copiar para dentro.
  IF current_schema() <> 'public' THEN
    RETURN;
  END IF;
  FOR loja IN
    SELECT t.slug, t.schema_name, t.id
      FROM public.tenant t
     WHERE t.schema_name IS NOT NULL
       AND t.schema_name <> 'public'
       AND EXISTS (SELECT 1 FROM information_schema.schemata s WHERE s.schema_name = t.schema_name)
  LOOP
    RAISE NOTICE '[0016] copiando a loja % (schema %) para public', loja.slug, loja.schema_name;

    EXECUTE format(
      'INSERT INTO public.%I ("id", "name", "display_order", "active", "created_at", "tenant_id") SELECT "id", "name", "display_order", "active", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'category', loja.schema_name, 'category') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "name", "phone", "created_at", "email", "active", "photo_path", "cpf", "notes", "tenant_id") SELECT "id", "name", "phone", "created_at", "email", "active", "photo_path", "cpf", "notes", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'customer', loja.schema_name, 'customer') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("phone", "items", "updated_at", "expires_at", "tenant_id") SELECT "phone", "items", "updated_at", "expires_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'customer_cart', loja.schema_name, 'customer_cart') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "name", "area_geografica", "created_at", "tenant_id") SELECT "id", "name", "area_geografica", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'delivery_region', loja.schema_name, 'delivery_region') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("cache_key", "response", "created_at", "expires_at", "tenant_id") SELECT "cache_key", "response", "created_at", "expires_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'geocoding_cache', loja.schema_name, 'geocoding_cache') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("correlation_id", "endpoint", "request_hash", "response_body", "response_status", "status", "created_at", "expires_at", "tenant_id") SELECT "correlation_id", "endpoint", "request_hash", "response_body", "response_status", "status", "created_at", "expires_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'idempotency_key', loja.schema_name, 'idempotency_key') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "name", "display_order", "active", "created_at", "tenant_id") SELECT "id", "name", "display_order", "active", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'kitchen_group', loja.schema_name, 'kitchen_group') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "seq", "event_type", "payload", "room", "published", "created_at", "tenant_id") SELECT "id", "seq", "event_type", "payload", "room", "published", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'outbox_event', loja.schema_name, 'outbox_event') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "number", "status", "created_at", "tenant_id") SELECT "id", "number", "status", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'restaurant_table', loja.schema_name, 'restaurant_table') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "merchant_name", "merchant_city", "logo_path", "brand_color", "pix_key", "pix_key_type", "uses_tables", "kitchen_enabled", "uses_delivery", "inventory_enabled", "purchase_enabled", "enabled_payment_methods", "kitchen_prep_warn_min", "kitchen_prep_urgent_min", "kitchen_pickup_urgent_min", "delivery_fee", "restaurant_lat", "restaurant_long", "free_delivery_min", "delivery_fee_tiers", "printer_enabled", "printer_auto_print", "delivery_prep_minutes", "minutes_per_km", "cash_closing_tolerance", "cash_closing_require_approval_above", "cash_high_value_threshold", "tenant_id") SELECT "id", "merchant_name", "merchant_city", "logo_path", "brand_color", "pix_key", "pix_key_type", "uses_tables", "kitchen_enabled", "uses_delivery", "inventory_enabled", "purchase_enabled", "enabled_payment_methods", "kitchen_prep_warn_min", "kitchen_prep_urgent_min", "kitchen_pickup_urgent_min", "delivery_fee", "restaurant_lat", "restaurant_long", "free_delivery_min", "delivery_fee_tiers", "printer_enabled", "printer_auto_print", "delivery_prep_minutes", "minutes_per_km", "cash_closing_tolerance", "cash_closing_require_approval_above", "cash_high_value_threshold", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'store_settings', loja.schema_name, 'store_settings') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "name", "phone", "tax_id", "active", "created_at", "updated_at", "tenant_id") SELECT "id", "name", "phone", "tax_id", "active", "created_at", "updated_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'supplier', loja.schema_name, 'supplier') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "name", "role", "pin_hash", "failed_attempts", "locked_until", "active", "created_at", "updated_at", "phone", "email", "photo_path", "account_id", "tenant_id") SELECT "id", "name", "role", "pin_hash", "failed_attempts", "locked_until", "active", "created_at", "updated_at", "phone", "email", "photo_path", "account_id", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'user', loja.schema_name, 'user') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "status", "opened_at", "opened_by", "opening_amount", "closed_at", "closed_by", "closing_expected", "closing_counted", "closing_difference", "closing_note", "note", "created_at", "closing_denominations", "closing_justification", "closing_approved_by", "tenant_id") SELECT "id", "status", "opened_at", "opened_by", "opening_amount", "closed_at", "closed_by", "closing_expected", "closing_counted", "closing_difference", "closing_note", "note", "created_at", "closing_denominations", "closing_justification", "closing_approved_by", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'cash_drawer', loja.schema_name, 'cash_drawer') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("courier_id", "latitude", "longitude", "accuracy", "updated_at", "position", "region_id", "tenant_id") SELECT "courier_id", "latitude", "longitude", "accuracy", "updated_at", "position", "region_id", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'courier_location', loja.schema_name, 'courier_location') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "customer_id", "label", "street", "number", "complement", "neighborhood", "city", "reference", "latitude", "longitude", "is_default", "created_at", "cep", "state", "tenant_id") SELECT "id", "customer_id", "label", "street", "number", "complement", "neighborhood", "city", "reference", "latitude", "longitude", "is_default", "created_at", "cep", "state", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'customer_address', loja.schema_name, 'customer_address') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "region_id", "geometry", "ordered_delivery_ids", "distance_meters", "duration_seconds", "created_at", "tenant_id") SELECT "id", "region_id", "geometry", "ordered_delivery_ids", "distance_meters", "duration_seconds", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'delivery_region_route', loja.schema_name, 'delivery_region_route') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "table_id", "customer_id", "tab_label", "waiter_id", "status", "opened_at", "closed_at", "payment_method", "payment_confirmed_at", "payment_confirmed_by", "channel", "external_ref", "delivery_fee", "cancel_reason", "notes", "tenant_id") SELECT "id", "table_id", "customer_id", "tab_label", "waiter_id", "status", "opened_at", "closed_at", "payment_method", "payment_confirmed_at", "payment_confirmed_by", "channel", "external_ref", "delivery_fee", "cancel_reason", "notes", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'order', loja.schema_name, 'order') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "category_id", "kitchen_group_id", "name", "description", "price", "variations", "image_path", "featured", "cost_price", "low_stock_threshold", "track_stock", "unit", "active", "created_at", "updated_at", "tenant_id") SELECT "id", "category_id", "kitchen_group_id", "name", "description", "price", "variations", "image_path", "featured", "cost_price", "low_stock_threshold", "track_stock", "unit", "active", "created_at", "updated_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'product', loja.schema_name, 'product') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "user_id", "code_hash", "code_hint", "created_by", "expires_at", "revoked_at", "email_sent_at", "created_at", "updated_at", "tenant_id") SELECT "id", "user_id", "code_hash", "code_hint", "created_by", "expires_at", "revoked_at", "email_sent_at", "created_at", "updated_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'provisioning_key', loja.schema_name, 'provisioning_key') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "supplier_id", "invoice_number", "issued_on", "note", "total", "created_by", "created_at", "tenant_id") SELECT "id", "supplier_id", "invoice_number", "issued_on", "note", "total", "created_by", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'purchase', loja.schema_name, 'purchase') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "seq", "kind", "title", "body", "order_id", "channel", "audience_roles", "read_at", "created_at", "tenant_id") SELECT "id", "seq", "kind", "title", "body", "order_id", "channel", "audience_roles", "read_at", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'alert', loja.schema_name, 'alert') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "user_id", "action", "order_id", "details", "created_at", "tenant_id") SELECT "id", "user_id", "action", "order_id", "details", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'audit_log', loja.schema_name, 'audit_log') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "drawer_id", "type", "amount", "note", "ref_order_id", "created_by", "created_at", "category", "tenant_id") SELECT "id", "drawer_id", "type", "amount", "note", "ref_order_id", "created_by", "created_at", "category", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'cash_drawer_movement', loja.schema_name, 'cash_drawer_movement') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "order_id", "courier_id", "address", "distance_km", "estimated_minutes", "status", "dispatched_at", "delivered_at", "notes", "created_at", "coordinate", "region_id", "route_order", "tenant_id") SELECT "id", "order_id", "courier_id", "address", "distance_km", "estimated_minutes", "status", "dispatched_at", "delivered_at", "notes", "created_at", "coordinate", "region_id", "route_order", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'delivery', loja.schema_name, 'delivery') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "order_id", "product_id", "quantity", "unit_price", "cost_price", "selected_variations", "notes", "status", "version", "created_by", "created_at", "updated_at", "tenant_id") SELECT "id", "order_id", "product_id", "quantity", "unit_price", "cost_price", "selected_variations", "notes", "status", "version", "created_by", "created_at", "updated_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'order_item', loja.schema_name, 'order_item') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "order_id", "method", "amount", "received", "change", "confirmed", "confirmed_at", "confirmed_by", "created_by", "created_at", "tenant_id") SELECT "id", "order_id", "method", "amount", "received", "change", "confirmed", "confirmed_at", "confirmed_by", "created_by", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'order_payment', loja.schema_name, 'order_payment') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "seq", "purchase_id", "product_id", "quantity", "unit_cost", "line_total", "batch_no", "expiry_date", "created_by", "created_at", "tenant_id") SELECT "id", "seq", "purchase_id", "product_id", "quantity", "unit_cost", "line_total", "batch_no", "expiry_date", "created_by", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'purchase_item', loja.schema_name, 'purchase_item') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "user_id", "provisioning_key_id", "label", "platform", "app_profile", "device_secret_hash", "active", "last_seen_at", "revoked_at", "created_at", "updated_at", "tenant_id") SELECT "id", "user_id", "provisioning_key_id", "label", "platform", "app_profile", "device_secret_hash", "active", "last_seen_at", "revoked_at", "created_at", "updated_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'user_device', loja.schema_name, 'user_device') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "order_id", "order_payment_id", "amount", "method", "reason", "status", "requested_by", "requested_at", "settled_at", "notes", "created_at", "tenant_id") SELECT "id", "order_id", "order_payment_id", "amount", "method", "reason", "status", "requested_by", "requested_at", "settled_at", "notes", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'order_refund', loja.schema_name, 'order_refund') USING loja.id;
    EXECUTE format(
      'INSERT INTO public.%I ("id", "seq", "product_id", "type", "quantity_delta", "unit_cost", "purchase_item_id", "order_id", "order_item_id", "note", "created_by", "created_at", "tenant_id") SELECT "id", "seq", "product_id", "type", "quantity_delta", "unit_cost", "purchase_item_id", "order_id", "order_item_id", "note", "created_by", "created_at", $1::uuid FROM %I.%I ON CONFLICT DO NOTHING',
      'stock_movement', loja.schema_name, 'stock_movement') USING loja.id;
  END LOOP;
END
$copia$;


-- ---------------------------------------------------------------------------
-- 4. As sequencias
-- ---------------------------------------------------------------------------
-- As quatro tabelas com `seq` (a ordem de criacao do dado) tem sequence
-- propria. A copia traz o `seq` explicito, entao a sequence fica ATRAS do
-- dado copiado e o proximo `nextval` repetiria valor.

DO $seqs$
DECLARE
  loja RECORD;
  maximo BIGINT;
BEGIN
  IF current_schema() <> 'public' THEN
    RETURN;
  END IF;
  FOR loja IN
    SELECT t.slug, t.schema_name
      FROM public.tenant t
     WHERE t.schema_name IS NOT NULL
       AND t.schema_name <> 'public'
       AND EXISTS (SELECT 1 FROM information_schema.schemata s WHERE s.schema_name = t.schema_name)
  LOOP

    EXECUTE format('SELECT max(seq) FROM %I.%I', loja.schema_name, 'alert') INTO maximo;
    IF maximo IS NOT NULL THEN
      PERFORM setval('public.alert_seq_seq', maximo, true);
    END IF;
    EXECUTE format('SELECT max(seq) FROM %I.%I', loja.schema_name, 'outbox_event') INTO maximo;
    IF maximo IS NOT NULL THEN
      PERFORM setval('public.outbox_event_seq_seq', maximo, true);
    END IF;
    EXECUTE format('SELECT max(seq) FROM %I.%I', loja.schema_name, 'purchase_item') INTO maximo;
    IF maximo IS NOT NULL THEN
      PERFORM setval('public.purchase_item_seq_seq', maximo, true);
    END IF;
    EXECUTE format('SELECT max(seq) FROM %I.%I', loja.schema_name, 'stock_movement') INTO maximo;
    IF maximo IS NOT NULL THEN
      PERFORM setval('public.stock_movement_seq_seq', maximo, true);
    END IF;
  END LOOP;
END
$seqs$;
