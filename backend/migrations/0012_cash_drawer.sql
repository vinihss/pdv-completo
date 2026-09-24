-- ============================================================
-- Migration 0012 — fluxo de caixa (abertura, sangria, suprimento,
-- fechamento). Uma sessão de caixa aberta por vez: `cash_drawer`
-- guarda a sessão (fundo inicial, abridor/fechador, conferência do
-- fechamento) e `cash_drawer_movement` registra sangrias/suprimentos.
-- As vendas em dinheiro NÃO viram linha aqui: o "esperado" no caixa
-- é calculado em usecase a partir de order_payment (method='cash',
-- confirmed, confirmed_at dentro do período da sessão). Valores em
-- reais (REAL), consistente com as demais colunas monetárias.
-- ============================================================

CREATE TABLE IF NOT EXISTS cash_drawer (
    id                 TEXT PRIMARY KEY,
    status             TEXT NOT NULL CHECK (status IN ('open','closed')),
    opened_at          TEXT NOT NULL,
    opened_by          TEXT NOT NULL REFERENCES "user"(id),
    opening_amount     REAL NOT NULL DEFAULT 0 CHECK (opening_amount >= 0),
    closed_at          TEXT,
    closed_by          TEXT REFERENCES "user"(id),
    closing_expected   REAL,             -- calculado no fechamento
    closing_counted    REAL,             -- contado informado pelo usuário
    closing_difference REAL,             -- counted - expected
    note               TEXT,
    created_at         TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE TABLE IF NOT EXISTS cash_drawer_movement (
    id         TEXT PRIMARY KEY,
    drawer_id  TEXT NOT NULL REFERENCES cash_drawer(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('sangria','suprimento')),
    amount     REAL NOT NULL CHECK (amount > 0),
    note       TEXT,
    created_by TEXT NOT NULL REFERENCES "user"(id),
    created_at TEXT NOT NULL DEFAULT (current_timestamp)
);

-- Sessão única: no máximo uma linha com status='open' (parcial).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_drawer_single_open
    ON cash_drawer(status) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_cash_drawer_movement_drawer ON cash_drawer_movement(drawer_id);