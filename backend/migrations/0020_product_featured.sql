-- ============================================================
-- Migration 0020 — destaque na página pública de pedidos
-- `product.featured` marca os produtos que abrem a primeira seção
-- ("Destaques") da página /pedido, no layout de loja do iFood
-- (docs/04 §Layout da página). É só curadoria de vitrine: o produto
-- continua aparecendo na sua categoria normalmente, então nada aqui
-- muda a lógica de preço, estoque, variations ou cardápio — apenas
-- mais um booleano no payload de GET /public/menu.
--
-- Default 0: instalação existente não muda de layout até o gerente
-- marcar produtos como destaque (mesmo critério das flags
-- inventory_enabled/purchase_enabled).
-- ============================================================

ALTER TABLE product ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;

-- A página pública monta a seção de destaques em memória a partir do
-- payload do menu; o índice ajuda o filtro server-side caso a listagem
-- do gerente passe a filtrar por destaque.
CREATE INDEX IF NOT EXISTS idx_product_featured ON product (featured);
