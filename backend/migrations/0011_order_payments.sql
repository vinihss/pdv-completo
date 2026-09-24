-- ============================================================
-- Migration 0011 — pagamento fracionado por forma de pagamento.
-- Uma comanda pode ser paga com várias formas (dinheiro + cartão
-- + pix + ...). Cada "pedaço" vira uma linha em order_payment;
-- order.payment_method continua como denormalizado de exibição
-- (1 método = só ele; vários = null). Valores em reais (REAL),
-- consistente com as demais colunas monetárias do schema.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_payment (
    id             TEXT PRIMARY KEY,
    order_id       TEXT NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
    method         TEXT NOT NULL CHECK (method IN ('cash','card','pix','other')),
    amount         REAL NOT NULL CHECK (amount > 0),
    received       REAL,             -- só cash: quanto o cliente entregou
    change         REAL,             -- só cash: received - amount (troco)
    confirmed      INTEGER NOT NULL DEFAULT 0,
    confirmed_at   TEXT,
    confirmed_by   TEXT REFERENCES "user"(id),
    created_by     TEXT NOT NULL REFERENCES "user"(id),
    created_at     TEXT NOT NULL DEFAULT (current_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_order_payment_order ON order_payment(order_id);