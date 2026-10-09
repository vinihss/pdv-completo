-- Migration 0006: Tabela order_refund
-- Estorno de linhas de pagamento do PDV (fonte da verdade no relatório de vendas).
-- Diferente de payment_refund (Pagar.me gateway) — aqui é o estorno manual no balcão.

-- Tabela de estornos de pagamentos (refund rastreável)
CREATE TABLE IF NOT EXISTS order_refund (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  order_payment_id text NOT NULL REFERENCES order_payment(id) ON DELETE CASCADE,
  amount real NOT NULL,
  method text NOT NULL,  -- 'cash' | 'card' | 'pix' | 'other'
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested',  -- 'requested' | 'settled' | 'failed'
  requested_by text NOT NULL REFERENCES "user"(id),
  requested_at text NOT NULL,
  settled_at text,
  notes text,
  created_at text NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- Índices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_order_refund_order ON order_refund(order_id);
CREATE INDEX IF NOT EXISTS idx_order_refund_payment ON order_refund(order_payment_id);
CREATE INDEX IF NOT EXISTS idx_order_refund_status ON order_refund(status);

-- Constraints de validação
ALTER TABLE order_refund ADD CONSTRAINT chk_order_refund_amount CHECK (amount > 0);
ALTER TABLE order_refund ADD CONSTRAINT chk_order_refund_status CHECK (status IN ('requested', 'settled', 'failed'));
