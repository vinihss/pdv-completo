-- ============================================================
-- Migration 0014 — estorno de comanda paga em dinheiro.
-- `cash_drawer_movement.ref_order_id` marca qual comanda gerou uma
-- sangria automática de estorno (ver order.usecases importante a
-- respeito de data: a sangria de estorno registra o ID da comanda
-- cancelada para rastreabilidade no relatório do caixa.
-- ============================================================

ALTER TABLE cash_drawer_movement ADD COLUMN ref_order_id TEXT REFERENCES "order"(id);