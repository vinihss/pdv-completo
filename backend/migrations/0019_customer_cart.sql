-- ============================================================
-- Migration 0019 — carrinho server-side do cliente (customer_cart)
-- Continuação do pedido: cliente que fechou/reload no meio do checkout
-- reabre o link e continua de onde parou — carrinho é server-authoritative
-- (sem localStorage), chaveado pelo telefone (mesma chave de identificação
-- do fluxo self-service). Formato de items espelha o body de
-- POST /public/orders (sem validação — rascunho, validação acontece no
-- submit). Mesmo desenho previsto no §04 (whatsapp_conversation.cart_items,
-- hoje não usado) — tabela dedicada pra não acoplar carrinho ao estado da
-- conversa do bot.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_cart (
    phone       TEXT PRIMARY KEY,
    items       TEXT NOT NULL DEFAULT '[]',
    updated_at  TEXT NOT NULL DEFAULT (current_timestamp),
    expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_cart_expires ON customer_cart(expires_at);
