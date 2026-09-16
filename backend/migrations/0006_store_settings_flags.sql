-- Flags de operação na configuração da loja
-- uses_delivery: habilita a página externa de pedidos (público /pedido)
-- ifood_integration_enabled: habilita a integração com iFood — quando
-- desligada, a flag iFood some do cadastro de produto.
ALTER TABLE store_settings ADD COLUMN uses_delivery INTEGER NOT NULL DEFAULT 1;
ALTER TABLE store_settings ADD COLUMN ifood_integration_enabled INTEGER NOT NULL DEFAULT 0;