-- Device provisioning (docs/21-device-provisioning.md) — PR 1.
--
-- Chave de provisionamento (multi-uso até revoked_at/expires_at) + aparelhos
-- autenticados por usuário. Regra vigente: baseline único (0001_init.sql) +
-- incrementais numerados; esta é a 0004. Idempotente (CREATE ... IF NOT EXISTS).
-- Índices NÃO usam CONCURRENTLY de propósito: o runner aplica cada arquivo
-- dentro de uma transação (`src/infra/db/migrate.ts`).
--
-- As duas tabelas são de negócio e referenciam `user(id)` do tenant, então
-- seguem o schema do tenant (hoje `public`, Fase 1 do multi-tenant); nada
-- disto entra em `migrations/registry/`.

-- Chave de provisionamento (multi-uso até revoked_at/exp)
CREATE TABLE IF NOT EXISTS public.provisioning_key (
    id              text PRIMARY KEY,
    user_id         text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    code_hash       text NOT NULL,      -- argon2 do código; texto puro nunca persiste
    code_hint       text NOT NULL,      -- sufixo p/ exibir sem expor ("…K7QF")
    created_by      text REFERENCES public."user"(id),
    expires_at      text,               -- null = sem expiração
    revoked_at      text,
    email_sent_at   text,
    created_at      text NOT NULL,
    updated_at      text NOT NULL
);
-- no máximo 1 chave ativa por usuário (índice único parcial)
CREATE UNIQUE INDEX IF NOT EXISTS uq_provisioning_key_active
    ON public.provisioning_key (user_id) WHERE revoked_at IS NULL;

-- Aparelho autenticado
CREATE TABLE IF NOT EXISTS public.user_device (
    id                  text PRIMARY KEY,
    user_id             text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    provisioning_key_id text REFERENCES public.provisioning_key(id),
    label               text,            -- "Galaxy A54", tirado do user-agent/app
    platform            text NOT NULL,   -- android | ios | web | desktop
    app_profile         text NOT NULL,   -- garcon | entregador | pdv | kds
    device_secret_hash  text NOT NULL,   -- argon2 do device token (texto puro só 1x)
    active              boolean NOT NULL DEFAULT true,
    last_seen_at        text,
    revoked_at          text,
    created_at          text NOT NULL,
    updated_at          text NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_user_device_user
    ON public.user_device (user_id) WHERE active = true;