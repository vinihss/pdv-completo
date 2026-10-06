-- ============================================================
-- Migration 0003 — Localização do entregador (courier_location).
--
-- Última posição conhecida por entregador, alimentada pelo app do courier
-- enquanto ele tem entrega em rota (`out_for_delivery`). Uma linha POR
-- entregador (PK = courier_id): o POST faz upsert, não append — histórico
-- de trajeto não é caso de uso do PDV hoje, e guardar trilha completa é
-- custo de armazenamento + superfície de privacidade sem ninguém consumindo.
--
-- Sem audit_log no caminho do ping: é um evento de alta frequência (o app
-- manda a cada poucos segundos), auditar poluiria o log sem valor forense.
-- O rastro que importa — "o gerente viu o entregador aqui às X" — é o
-- próprio evento realtime publicado via outbox na mesma transação do upsert.
--
-- Idempotente: IF NOT EXISTS, como o resto do repo.
-- ============================================================

CREATE TABLE IF NOT EXISTS courier_location (
  courier_id  TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  latitude    REAL NOT NULL,
  longitude   REAL NOT NULL,
  accuracy    REAL,                       -- metros, opcional (nem todo device informa)
  updated_at  TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),

  CONSTRAINT chk_courier_location_lat CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT chk_courier_location_long CHECK (longitude BETWEEN -180 AND 180)
);
