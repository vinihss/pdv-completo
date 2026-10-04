-- ============================================================
-- Migration 0002 — Embedded Signup (WhatsApp Cloud API).
--
-- Antes desta migration o "canal WhatsApp" era configurado por env
-- global (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID), o que só
-- funciona para um dono de WABA rodando seu próprio PDV. O Embedded
-- Signup inverte isso: quem conecta é o DONO DA LOJA, dentro do painel
-- dele, e o token passa a ser POR WABA. Ver docs/10-whatsapp-embedded-signup.md.
--
-- O que entra:
--   - `whatsapp_connection`             a WABA conectada (token, número,
--                                       status) — uma `active` por instalação.
--   - `whatsapp_outbound_message`      uma linha por mensagem enviada,
--                                       chaveada pelo wamid que a Meta
--                                       devolve. É o que permite casar o
--                                       webhook de status (`messages.statuses`)
--                                       com o pedido do cliente.
--   - `whatsapp_inbound_message`       dedupe das mensagens recebidas: a
--                                       Meta reenvia o mesmo webhook por
--                                       ~7 dias enquanto não houver 200.
--   - `whatsapp_conversation.waba_id`  rastreabilidade (ver nota abaixo).
--
-- Timestamps em TEXT ISO-8601 UTC, igual ao resto do schema — o app
-- compara com new Date().toISOString() e a ordenação lexicográfica de
-- text uniforme é cronológica (ver a nota de contrato em 0001_init.sql).
-- ============================================================

-- ---------------------------------------------------------------- enums
CREATE TYPE whatsapp_connection_status AS ENUM ('active', 'expired', 'revoked', 'disconnected');
CREATE TYPE whatsapp_message_status   AS ENUM ('sent', 'delivered', 'read', 'failed');
CREATE TYPE whatsapp_message_kind     AS ENUM ('notification', 'bot_reply');

-- ---------------------------------------------------------------- conexões
-- Chave natural é waba_id (o id da conta de WhatsApp Business), não a
-- instalação: reconectar o mesmo WABA renova a linha em vez de duplicar,
-- e trocar de WABA (número novo) é um insert. phone_number_id é o id do
-- número de negócio — é ele que a API de envio e o webhook endereçam.
CREATE TABLE whatsapp_connection (
  id                     TEXT PRIMARY KEY,
  waba_id                TEXT NOT NULL UNIQUE,
  phone_number_id        TEXT NOT NULL,
  business_id            TEXT,
  business_name          TEXT,
  display_phone_number   TEXT,
  display_name           TEXT,
  access_token           TEXT NOT NULL,
  -- ISO-8601. NULL = token sem expiração (o caso normal do token BISU
  -- devolvido pelo Embedded Signup); preenchido quando a Meta manda
  -- expires_in, para installations em configuração não-padrão.
  token_expires_at       TEXT,
  status                 whatsapp_connection_status NOT NULL DEFAULT 'active',
  last_error             TEXT,
  created_at             TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at             TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- "Uma WABA ativa por instalação" fica no BANCO, não no usecase: índice
-- único sobre uma expressão constante, parcial em status = 'active'.
-- Duas conexões ativas violam o índice no INSERT, sem depender de todo
-- caminho de escrita lembrar de desativar a anterior.
CREATE UNIQUE INDEX uq_whatsapp_single_active
  ON whatsapp_connection ((true))
  WHERE status = 'active';

-- ---------------------------------------------------------------- mensagens enviadas
-- O id é o wamid que a Meta devolve no POST /{phone_number_id}/messages.
-- Guardá-lo é o que fecha o ciclo com o webhook de status: sem esta linha
-- não há como saber a qual pedido (ou a qual número) a mensagem entregue
-- pertence. order_id é nullable de propósito: o bot de auto-atendimento
-- também envia, e essa mensagem não pertence a nenhum pedido.
CREATE TABLE whatsapp_outbound_message (
  id            TEXT PRIMARY KEY,                  -- wamid (wamid.XXXX...)
  waba_id       TEXT NOT NULL REFERENCES whatsapp_connection(waba_id) ON DELETE CASCADE,
  order_id      TEXT REFERENCES "order"(id) ON DELETE CASCADE,
  to_phone      TEXT NOT NULL,
  kind          whatsapp_message_kind NOT NULL,
  status        whatsapp_message_status NOT NULL DEFAULT 'sent',
  error_code    INTEGER,
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at    TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_whatsapp_outbound_order ON whatsapp_outbound_message(order_id);
CREATE INDEX idx_whatsapp_outbound_waba_created ON whatsapp_outbound_message(waba_id, created_at);

-- ---------------------------------------------------------------- mensagens recebidas
-- Só a chave (wamid) e o mínimo de contexto. A Meta reenvia o MESMO
-- webhook enquanto não receber 200, por até ~7 dias; sem esta tabela o bot
-- trataria cada reenvio como uma fala nova do cliente. `type` é TEXT
-- livre, não enum: a Meta adiciona tipos sem aviso (interactive, button,
-- reaction, ...) e um enum quebraria no primeiro tipo novo.
CREATE TABLE whatsapp_inbound_message (
  id          TEXT PRIMARY KEY,                    -- wamid (wamid.XXXX...)
  waba_id     TEXT NOT NULL REFERENCES whatsapp_connection(waba_id) ON DELETE CASCADE,
  from_phone  TEXT NOT NULL,
  type        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX idx_whatsapp_inbound_waba ON whatsapp_inbound_message(waba_id);

-- ---------------------------------------------------------------- rastreabilidade
-- A conversa continua chaveada por phone (PK), e não por (waba_id, phone):
-- há UMA WABA ativa por instalação (uq_whatsapp_single_active), então o
-- par não carrega informação que o phone já não carregue. Guardar o
-- waba_id serve para auditar de qual WABA veio a fala — e para permitir
-- a composição do índice composto depois, se um dia houver multi-WABA,
-- sem ter que adivinhar depois de perder o histórico.
ALTER TABLE whatsapp_conversation ADD COLUMN waba_id TEXT;
