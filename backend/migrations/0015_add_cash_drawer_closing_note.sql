-- Observação de conferência do fechamento do caixa: justificativa opcional da
-- variação (closingExpected vs closingCounted) registrada no momento do close.
ALTER TABLE cash_drawer ADD COLUMN closing_note TEXT;