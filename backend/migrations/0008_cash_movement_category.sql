-- Migration 0008: Classificação de sangrias/suprimentos + alçadas
-- Adiciona campo `category` obrigatório em movimentos de caixa para classificar
-- o tipo de operação (sangria operacional, suprimento de troco, etc).
-- Adiciona limite de valor alto para movimentos que exigem aprovação.
-- Altera default da tolerância de fechamento de 0 para 5.0.

-- 1. Adicionar coluna `category` em cash_drawer_movement
ALTER TABLE cash_drawer_movement 
ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'outros';

-- Adicionar constraint CHECK para validar os valores permitidos
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'chk_cash_movement_category'
  ) THEN
    ALTER TABLE cash_drawer_movement 
    ADD CONSTRAINT chk_cash_movement_category 
    CHECK (category IN (
      'sangria_operacional', 
      'suprimento_troco', 
      'pagamento_fornecedor', 
      'ajuste_inventario', 
      'outros'
    ));
  END IF;
END $$;

-- 2. Alterar default de cash_closing_tolerance de 0 para 5.0
ALTER TABLE store_settings 
ALTER COLUMN cash_closing_tolerance SET DEFAULT 5.0;

-- 3. Adicionar coluna cash_high_value_threshold em store_settings
ALTER TABLE store_settings 
ADD COLUMN IF NOT EXISTS cash_high_value_threshold real NOT NULL DEFAULT 500.0;
