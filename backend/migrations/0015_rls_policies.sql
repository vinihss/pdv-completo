-- FASE 2 do workstream B: as POLICIES de RLS — a barreira de verdade.
--
-- Até aqui o isolamento era estrutural (um schema por loja, pool dedicado).
-- A partir daqui a barreira passa a ser do BANCO: um schema só, toda linha
-- com `tenant_id`, e a policy decidindo o que cada sessão enxerga.
--
-- A BARREIRA SÓ VALE COM O PAPEL CERTO
-- --------------------------------------
-- Superuser (e quem tem BYPASSRLS) ignora row security, inclusive com
-- `FORCE ROW LEVEL SECURITY`. A Fase 0 já deixou o app conectando com um
-- papel próprio (`pdv_app`, sem superuser e sem BYPASSRLS); este arquivo
-- é o que torna a policy viva. Se o app voltar a conectar como superuser, a
-- policy vira decoração — e o gateway Go já avisa disso no boot
-- (`ws-gateway/internal/db/role.go`, `DB_REQUIRE_RESTRICTED=1`).
--
-- POR QUE `current_setting` SEM `missing_ok`
-- ---------------------------------------
-- Sem contexto de tenant a query tem que FALHAR, não devolver vazio: um
-- vazio é indistinguível de "a loja não tem esse dado", e o app trata os
-- dois igual. Com `missing_ok = true` o `current_setting` devolveria NULL e
-- a policy silenciosamente filtraria TUDO. A forma sem `missing_ok` levanta
-- o erro "app.tenant_id is not set" — alto e claro.
--
-- O CONTEXTO VEM DA SESSÃO
-- -----------------------
-- O `app.tenant_id` é gravado no startup packet do POOL (o pool é por
-- tenant — `infra/db/tenant-db.ts`), e o Unit-of-Worker o reaffirmed por
-- transação. Nenhum código de aplicação escreve o id: é o banco que
-- carimba a linha (o trigger da migration `0013`).
--
-- `FORCE ROW LEVEL SECURITY` (e não só `ENABLE`): sem ele o DONO da
-- tabela — o papel das migrations — continuaria ignorando a policy. Com
-- ele, quem faz DDL (o dono) não vê o dado, e quem faz DML (o app, com o
-- GUC) vê só a própria loja.
--
-- O `schema_name` SAI DE CENA
-- --------------------------
-- No modelo por linha a loja não tem schema: o `schema_name` vira vestigial
-- (a Fase 3 tira a coluna). E o UNIQUE dele IMPEDIA o modelo de existir: no
-- schema único, TODAS as lojas teriam `schema_name = 'public'` — e o
-- constraint recusava a segunda. Por isso ele sai aqui, junto com a entrada do
-- modelo por linha.
--
-- A coluna continua existindo (com o CHECK relaxado, que aceita `public` e
-- NULL) porque o roteamento por schema ainda está no ar até a Fase 3.
ALTER TABLE public.tenant DROP CONSTRAINT IF EXISTS tenant_schema_name_key;

-- AS TABELAS DE CONTROLE FICAM DE FORA
-- -----------------------------------
-- `public.tenant`, `public.account`, `public.account_identity`,
-- `public.auth_session` e `public.password_reset` são o PLANO de
-- controle (o login, o registry das lojas), não dado de loja: elas não
-- recebem `tenant_id` e não recebem policy. É o que permite o login de
-- uma loja acontecer antes de o tenant estar resolvido.

ALTER TABLE "alert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_drawer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_drawer_movement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courier_location" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_address" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_cart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_region" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_region_route" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "geocoding_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_key" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kitchen_group" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_refund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provisioning_key" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_table" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_device" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "alert" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cash_drawer" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cash_drawer_movement" FORCE ROW LEVEL SECURITY;
ALTER TABLE "category" FORCE ROW LEVEL SECURITY;
ALTER TABLE "courier_location" FORCE ROW LEVEL SECURITY;
ALTER TABLE "customer" FORCE ROW LEVEL SECURITY;
ALTER TABLE "customer_address" FORCE ROW LEVEL SECURITY;
ALTER TABLE "customer_cart" FORCE ROW LEVEL SECURITY;
ALTER TABLE "delivery" FORCE ROW LEVEL SECURITY;
ALTER TABLE "delivery_region" FORCE ROW LEVEL SECURITY;
ALTER TABLE "delivery_region_route" FORCE ROW LEVEL SECURITY;
ALTER TABLE "geocoding_cache" FORCE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_key" FORCE ROW LEVEL SECURITY;
ALTER TABLE "kitchen_group" FORCE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
ALTER TABLE "order_item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "order_payment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "order_refund" FORCE ROW LEVEL SECURITY;
ALTER TABLE "outbox_event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;
ALTER TABLE "provisioning_key" FORCE ROW LEVEL SECURITY;
ALTER TABLE "purchase" FORCE ROW LEVEL SECURITY;
ALTER TABLE "purchase_item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_table" FORCE ROW LEVEL SECURITY;
ALTER TABLE "stock_movement" FORCE ROW LEVEL SECURITY;
ALTER TABLE "store_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "supplier" FORCE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;
ALTER TABLE "user_device" FORCE ROW LEVEL SECURITY;

-- A policy: `USING` filtra a LEITURA, `WITH CHECK` exige que a linha
-- escrita seja da própria loja (é o que impede o `INSERT` de outra loja).
CREATE POLICY tenant_isolation ON "alert"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "audit_log"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "cash_drawer"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "cash_drawer_movement"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "category"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "courier_location"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "customer"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "customer_address"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "customer_cart"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "delivery"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "delivery_region"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "delivery_region_route"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "geocoding_cache"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "idempotency_key"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "kitchen_group"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "order"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "order_item"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "order_payment"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "order_refund"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "outbox_event"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "product"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "provisioning_key"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "purchase"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "purchase_item"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "restaurant_table"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "stock_movement"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "store_settings"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "supplier"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "user"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_isolation ON "user_device"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

