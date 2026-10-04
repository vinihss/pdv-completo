-- ETA de entrega (faixas + tempo de preparo), observação do pedido e UF no endereço.
--
-- Adiciona colunas necessárias para:
-- 1. order.notes: observação do cliente no pedido completo (checkout público)
-- 2. store_settings: delivery_prep_minutes e minutes_per_km (cálculo de ETA por faixas)
-- 3. customer_address.state: UF (2 letras) para preencher via ViaCEP

-- order.notes
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS notes TEXT;

-- store_settings
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS delivery_prep_minutes INTEGER NOT NULL DEFAULT 40;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS minutes_per_km INTEGER NOT NULL DEFAULT 2;

-- customer_address.state (UF)
ALTER TABLE customer_address ADD COLUMN IF NOT EXISTS state TEXT;
