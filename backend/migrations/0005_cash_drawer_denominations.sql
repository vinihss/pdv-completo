-- Migration 0005: Fechamento de caixa com contagem por denominação
-- Adiciona colunas para denominar cédulas/moedas no fechamento, justificativa
-- quando há diferença acima da tolerância, e aprovação de gerente para
-- diferenças acima de limite configurável.
--
-- Colunas de store_settings: cash_closing_tolerance (em R$) é a margem para
-- dispensar justificativa; cash_closing_require_approval_above é o limite
-- acima do qual o fechamento exige o PIN de um gerente.

-- cash_drawer: colunas do fechamento com contagem
ALTER TABLE cash_drawer ADD COLUMN IF NOT EXISTS closing_denominations text;
ALTER TABLE cash_drawer ADD COLUMN IF NOT EXISTS closing_justification text;
ALTER TABLE cash_drawer ADD COLUMN IF NOT EXISTS closing_approved_by text REFERENCES "user"(id);

-- store_settings: limites configuráveis para tolerância e alçada de aprovação
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS cash_closing_tolerance real NOT NULL DEFAULT 0;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS cash_closing_require_approval_above real NOT NULL DEFAULT 0;
