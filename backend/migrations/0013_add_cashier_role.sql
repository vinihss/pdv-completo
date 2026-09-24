-- ============================================================
-- Migration 0013 — novo papel "cashier" (caixa) em "user". O caixa
-- opera o fluxo de caixa junto com o gerente (requireRole nos
-- endpoints de /cash-drawer). SQLite não permite alterar CHECK via
-- ALTER TABLE: recria a tabela seguindo a técnica oficial de 12
-- passos, mesmo padrão usado na 0002.
-- ============================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE "user_new" (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('waiter','kitchen','manager','courier','system','cashier')),
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