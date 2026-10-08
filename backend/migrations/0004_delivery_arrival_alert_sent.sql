-- ============================================================
-- Migration 0004 — Flag de alerta de chegada de entrega.
--
-- Para enviar o WhatsApp "Sua entrega está chegando!" quando o entregador
-- estiver a 5 minutos do destino. A flag evita que a mesma notificação
-- seja disparada repetidamente no mesmo pedido enquanto a entrega
-- permanece em rota.
--
-- Sem audit_log — muda de estado do pedido, não de dados sensíveis.
--
-- Idempotente: o runner de migrations re-tenta qualquer arquivo sem linha em
-- `_migrations`, e o drift já aconteceu em produção — esta migration abortou o
-- boot em 08/10 com "column already exists" e derrubou o deploy da tag (o gate
-- de saúde do switch abortou). `IF NOT EXISTS` heal o drift em vez de quebrar.
-- ============================================================

ALTER TABLE delivery
  ADD COLUMN IF NOT EXISTS arrival_alert_sent BOOLEAN NOT NULL DEFAULT FALSE;