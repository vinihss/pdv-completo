-- ============================================================
-- Migration 0009 — Sessão WhatsApp Web (provider Baileys).
--
-- Sessão de longa duração do WhatsApp Web: com o provider
-- "baileys" o backend mantém o cliente de sockets no próprio
-- processo (sem webhooks), e é AQUI que vivem as credenciais +
-- chaves Signal — o que permite retomar a sessão depois de um
-- restart sem parear de novo. É o equivalente a whatsapp_connection
-- (migration 0001) para o provider oficial, mas para o provider
-- de sockets. Ver src/integrations/whatsapp/socket/.
--
-- session_data é jsonb opaco: só o adapter do Baileys lê, e
-- NUNCA sai por rota (mesma política do access_token do Embedded
-- Signup — ver docs/10 §2).
--
-- Colunas de tempo seguem a convenção do repo (text ISO-8601 UTC
-- com default to_char, igual ao baseline): ordenação lexicográfica
-- = cronológica, e o app compara/escreve com toISOString().
--
-- Idempotente: IF NOT EXISTS / DO-block, como o resto do repo.
-- Índice NÃO usa CONCURRENTLY de propósito: o runner aplica cada
-- arquivo dentro de uma transação (src/infra/db/migrate.ts).
-- ============================================================

DO $$ BEGIN
    CREATE TYPE whatsapp_socket_session_status AS ENUM ('active', 'disconnected');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS whatsapp_socket_session (
    id           text PRIMARY KEY DEFAULT gen_random_uuid(),
    phone        text NOT NULL,               -- número da loja pareado com o WhatsApp Web
    session_data jsonb NOT NULL,              -- creds + chaves Signal do Baileys (opaco)
    status       whatsapp_socket_session_status NOT NULL DEFAULT 'active',
    last_error   text,
    linked_at    text,                        -- desde quando a sessão está vinculada
    last_seen_at text,                        -- última atividade (heartbeat)
    created_at   text NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at   text NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- No máximo UMA sessão ativa por instalação — mesma política de
-- uq_whatsapp_single_active (baseline 0001) para a Cloud API.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_socket_session_active
    ON whatsapp_socket_session ((true)) WHERE (status = 'active'::whatsapp_socket_session_status);
