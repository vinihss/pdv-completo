-- Migration 0007: Tabela order_settlement
-- Settlement de marketplace (iFood): separa receita bruta de repasse líquido.
-- Elimina a contaminação da receita de marketplace no relatório de vendas.
--
-- Um settlement por pedido (UNIQUE em order_id). Para pedidos iFood, o payout_amount
-- é o que efetivamente a loja recebe após comissões e taxas. Para pedidos de outros
-- canais, o settlement é opcional (fallback: usar orders.total).

-- Tabela de settlements de marketplace
CREATE TABLE IF NOT EXISTS order_settlement (
  id text PRIMARY KEY,
  order_id text NOT NULL UNIQUE REFERENCES "order"(id) ON DELETE CASCADE,
  channel text NOT NULL,  -- 'ifood', 'whatsapp', etc.
  gross_amount real NOT NULL,  -- valor bruto do pedido
  commission_amount real NOT NULL,  -- comissão do marketplace
  marketplace_fee real NOT NULL DEFAULT 0,  -- taxa adicional do marketplace
  delivery_fee_subsidy real NOT NULL DEFAULT 0,  -- subsídio de entrega (negativo se custo)
  payout_amount real NOT NULL,  -- valor líquido a receber (gross - commission - fee - subsidy)
  payout_status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid' | 'failed'
  payout_expected_at text,  -- data esperada de recebimento (ISO-8601)
  payout_settled_at text,  -- data efetiva de recebimento (ISO-8601)
  external_ref text,  -- referência externa do marketplace (ex: order_id do iFood)
  notes text,
  created_at text NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at text NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- Índices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_order_settlement_order ON order_settlement(order_id);
CREATE INDEX IF NOT EXISTS idx_order_settlement_channel ON order_settlement(channel);
CREATE INDEX IF NOT EXISTS idx_order_settlement_payout_status ON order_settlement(payout_status);
CREATE INDEX IF NOT EXISTS idx_order_settlement_payout_expected_at ON order_settlement(payout_expected_at);

-- Constraints de validação
ALTER TABLE order_settlement ADD CONSTRAINT chk_order_settlement_gross CHECK (gross_amount >= 0);
ALTER TABLE order_settlement ADD CONSTRAINT chk_order_settlement_commission CHECK (commission_amount >= 0);
ALTER TABLE order_settlement ADD CONSTRAINT chk_order_settlement_fee CHECK (marketplace_fee >= 0);
ALTER TABLE order_settlement ADD CONSTRAINT chk_order_settlement_payout CHECK (payout_amount >= 0);
ALTER TABLE order_settlement ADD CONSTRAINT chk_order_settlement_status CHECK (payout_status IN ('pending', 'paid', 'failed'));
