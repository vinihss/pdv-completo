-- ============================================================
-- Migration 0004 — Flag de alerta de chegada de entrega.
--
-- Para enviar o WhatsApp "Sua entrega está chegando!" quando o entregador
-- estiver a 5 minutos do destino. A flag evita que a mesma notificação
-- seja disparada repetidamente no mesmo pedido enquanto a entrega
-- permanece em rota.
--
-- Sem audit_log — muda de estado do pedido, não de dados sensíveis.
-- ============================================================

ALTER TABLE delivery
  ADD COLUMN arrival_alert_sent BOOLEAN NOT NULL DEFAULT FALSE;