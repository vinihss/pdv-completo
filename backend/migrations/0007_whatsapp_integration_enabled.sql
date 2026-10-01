-- Integração WhatsApp como parâmetro de configuração.
--
-- O painel do WhatsApp (conexão via Embedded Signup + histórico de mensagens)
-- deixa de ser item fixo do menu esquerdo e passa a morar dentro de
-- Configurações, aparecendo só quando esta flag está ligada. É o mesmo
-- desenho do `ifood_integration_enabled`: um toggle no "Modo de operação" que
-- decide se a superfície existe.
--
-- DEFAULT false de propósito (e não true): a flag é opt-in. Loja que já usava
-- WhatsApp liga o toggle uma vez em Configurações; loja nova começa com a
-- integração fora do caminho.
--
-- NOT NULL com DEFAULT é expand-safe: a versão antiga do backend não conhece
-- a coluna, não escreve nela e continua servindo o valor antigo; a nova, com
-- um frontend ainda não atualizado, recebe o campo ausente no PUT e mantém o
-- valor gravado (o zod marca o campo como opcional).
--
-- IF NOT EXISTS: reexecutar a migration é seguro (mesma régua de
-- 0005_customer_address_cep.sql).

ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS whatsapp_integration_enabled BOOLEAN NOT NULL DEFAULT false;
