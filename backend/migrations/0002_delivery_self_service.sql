-- ============================================================
-- Migration 0002 — pedido self-service delivery (WhatsApp + página externa)
-- Espelha docs/04-delivery-self-service-integration.md e
-- docs/05-delivery-api-contracts.md. Nunca editar depois de commitada;
-- mudanças futuras de schema entram como novos arquivos (§14.5).
-- ============================================================

-- ------------------------------------------------------------
-- 1. "user" — adiciona role "courier" (entregador) e "system"
--    (ator técnico para pedidos self-service, nunca faz login).
--    SQLite não permite alterar CHECK via ALTER TABLE: recria a
--    tabela seguindo a técnica oficial de 12 passos.
-- ------------------------------------------------------------
PRAGMA foreign_keys = OFF;

CREATE TABLE "user_new" (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('waiter','kitchen','manager','courier','system')),
    pin_hash        TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp),
    updated_at      TEXT NOT NULL DEFAULT (current_timestamp)
);

INSERT INTO "user_new" SELECT * FROM "user";
DROP TABLE "user";
ALTER TABLE "user_new" RENAME TO "user";

PRAGMA foreign_keys = ON;

-- Usuário de sistema fixo — alvo de FK para order.waiter_id e audit_log.user_id
-- em pedidos self-service, que não têm garçom nem gerente responsável.
-- active = 0 impede login (mesmo mecanismo já usado para desativar funcionário).
-- pin_hash é um placeholder inutilizável: nunca passa por comparação real de PIN
-- porque o login já bloqueia active = 0 antes de chegar lá.
INSERT INTO "user" (id, name, role, pin_hash, active)
VALUES ('system', 'Pedidos automáticos (self-service)', 'system', 'SYSTEM_ACCOUNT_NO_LOGIN', 0)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 2. "order" — origem do pedido e taxa de entrega cobrada
-- ------------------------------------------------------------
ALTER TABLE "order" ADD COLUMN channel TEXT NOT NULL DEFAULT 'balcao'
    CHECK (channel IN ('balcao','whatsapp','web'));
ALTER TABLE "order" ADD COLUMN external_ref TEXT;
ALTER TABLE "order" ADD COLUMN delivery_fee REAL;

-- ------------------------------------------------------------
-- 3. "store_settings" — taxa de entrega fixa configurável
-- ------------------------------------------------------------
ALTER TABLE store_settings ADD COLUMN delivery_fee REAL NOT NULL DEFAULT 0;

-- ------------------------------------------------------------
-- 4. "customer_address" — até 3 por cliente, 1 principal
--    (limite e unicidade do padrão aplicados em usecase, não aqui)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_address (
    id              TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
    label           TEXT,
    street          TEXT NOT NULL,
    number          TEXT NOT NULL,
    complement      TEXT,
    neighborhood    TEXT NOT NULL,
    city            TEXT NOT NULL,
    reference       TEXT,
    is_default      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_customer_address_customer ON customer_address(customer_id);

-- ------------------------------------------------------------
-- 5. "whatsapp_conversation" — estado da máquina de conversa do bot
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_conversation (
    phone             TEXT PRIMARY KEY,
    state             TEXT NOT NULL DEFAULT 'welcome'
                        CHECK (state IN ('welcome','browsing','cart','checkout','done')),
    cart_items        TEXT NOT NULL DEFAULT '[]',
    customer_name     TEXT,
    delivery_address  TEXT,
    updated_at        TEXT NOT NULL DEFAULT (current_timestamp),
    expires_at        TEXT NOT NULL
);

-- ------------------------------------------------------------
-- 6. "delivery" — gerência de entrega, 1:1 com pedidos delivery
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL UNIQUE REFERENCES "order"(id) ON DELETE CASCADE,
    courier_id      TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    address         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'awaiting_courier'
                        CHECK (status IN ('awaiting_courier','out_for_delivery','delivered','failed')),
    dispatched_at   TEXT,
    delivered_at    TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_delivery_courier ON delivery(courier_id);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery(status);
