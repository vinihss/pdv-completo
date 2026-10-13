-- Migration 0010: Remoção da camada de pagamento online (Pagar.me) e do iFood
--
-- A cobrança no gateway Pagar.me V5 e a integração iFood (Order/Catalog API,
-- worker de polling, pushback de status e ingestão) saíram do código, junto
-- com os settlements de marketplace que só existiam para o repasse do iFood e
-- as migrations 0002_pagarme.sql / 0007_order_settlement.sql (arquivos
-- removidos da cadeia ativa). Esta migration derruba o que sobrou no banco das
-- instalações que já aplicaram aquelas migrations.
--
-- O que É derrubado aqui:
--   * payment_refund, payment_event e payment (cobrança, inbox do webhook e
--     estornos do gateway) — `payment_event`/`payment_refund` referenciam
--     `payment`, então saem antes;
--   * order_settlement (repasse de marketplace, Bloco 5);
--   * ifood_event e ifood_state, e o enum ifood_event_status usado só por
--     `ifood_event`;
--   * order.ifood_payments (pagamento do pedido iFood em JSON);
--   * product.ifood_enabled / product.ifood_sku;
--   * store_settings.ifood_integration_enabled e store_settings.pagarme_enabled.
--
-- O que NÃO é derrubado, de propósito:
--   * o valor 'ifood' do enum `channel`, pela MESMA razão do 'whatsapp' em
--     0009_remove_whatsapp.sql: remover valor de enum em uso exige reescrever
--     as linhas que o carregam, e pedidos antigos continuam válidos como
--     histórico (relatório, reimpressão de cupom). Fica no enum, apenas
--     read-only no código;
--   * a coluna order.external_ref: é genérica (id do pedido no canal de
--     origem) e segue em uso.
--
-- Idempotente e seguro de reexecutar: toda queda é IF EXISTS. Ordem importa —
-- as tabelas que referenciam `payment` saem antes dela.

BEGIN;

DROP TABLE IF EXISTS payment_refund;
DROP TABLE IF EXISTS payment_event;
DROP TABLE IF EXISTS payment;

DROP TABLE IF EXISTS order_settlement;

DROP TABLE IF EXISTS ifood_event;
DROP TABLE IF EXISTS ifood_state;
DROP TYPE IF EXISTS ifood_event_status;

ALTER TABLE "order" DROP COLUMN IF EXISTS ifood_payments;

ALTER TABLE product DROP COLUMN IF EXISTS ifood_enabled;
ALTER TABLE product DROP COLUMN IF EXISTS ifood_sku;

ALTER TABLE store_settings DROP COLUMN IF EXISTS ifood_integration_enabled;
ALTER TABLE store_settings DROP COLUMN IF EXISTS pagarme_enabled;

COMMIT;
