-- Migration 0009: Remoção da integração WhatsApp
--
-- A integração com a WhatsApp Cloud API (webhook de entrada, bot de
-- auto-atendimento, Embedded Signup e as notificações de status enviadas ao
-- cliente) saiu do código. Esta migration remove o que sobrou dela no banco.
--
-- O que É derrubado aqui:
--   * whatsapp_connection, whatsapp_conversation, whatsapp_inbound_message,
--     whatsapp_outbound_message (com FKs/índices/constraints dependentes);
--   * os enums whatsapp_state, whatsapp_connection_status,
--     whatsapp_message_status, whatsapp_message_kind;
--   * store_settings.whatsapp_integration_enabled;
--   * delivery.arrival_alert_sent — a coluna existia somente para marcar o
--     alerta "sua entrega está chegando", que era uma mensagem de WhatsApp
--     disparada pelo cálculo de rota no ping de localização do entregador.
--
-- O que NÃO é derrubado, de propósito:
--   * o valor 'whatsapp' do enum `channel`. Remover um valor de enum em uso
--     exige reescrever as linhas que o carregam; pedidos antigos de delivery
--     feitos por esse canal continuam válidos como histórico (relatórios,
--     reimpressão de cupom, "pedido em andamento"), então o valor fica e é
--     apenas read-only no código.
--
-- Idempotente e seguro de reexecutar: toda queda é IF EXISTS, e o drop de
-- coluna usa IF EXISTS. Ordem importa — as tabelas de mensagem referenciam
-- whatsapp_connection, então a conexão é a última a sair.

BEGIN;

ALTER TABLE delivery DROP COLUMN IF EXISTS arrival_alert_sent;

ALTER TABLE store_settings DROP COLUMN IF EXISTS whatsapp_integration_enabled;

DROP TABLE IF EXISTS whatsapp_outbound_message;
DROP TABLE IF EXISTS whatsapp_inbound_message;
DROP TABLE IF EXISTS whatsapp_conversation;
DROP TABLE IF EXISTS whatsapp_connection;

DROP TYPE IF EXISTS whatsapp_message_kind;
DROP TYPE IF EXISTS whatsapp_message_status;
DROP TYPE IF EXISTS whatsapp_connection_status;
DROP TYPE IF EXISTS whatsapp_state;

COMMIT;
