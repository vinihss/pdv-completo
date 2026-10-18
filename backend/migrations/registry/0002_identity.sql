-- Registry migration 0002: Centralized identity tables (global, public schema)
-- DDL from docs/26-identidade-centralizada.md §3
-- Applied ONLY via registry runner (migrations/registry/*) in public.

CREATE TABLE IF NOT EXISTS public.account (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL,
  password_hash       TEXT,
  name                TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  created_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- Case-insensitive unique index on email
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_lower
  ON public.account (lower(email));

CREATE TABLE IF NOT EXISTS public.account_identity (
  account_id   TEXT NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('google','apple')),
  provider_sub TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (provider, provider_sub)
);

CREATE INDEX IF NOT EXISTS idx_account_identity_account ON public.account_identity(account_id);

CREATE TABLE IF NOT EXISTS public.auth_session (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  refresh_hash  TEXT NOT NULL,
  device_id     TEXT,
  tenant_slug   TEXT,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  rotated_from  TEXT,
  created_at    TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  last_seen_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_session_account ON public.auth_session(account_id);
CREATE INDEX IF NOT EXISTS idx_auth_session_refresh_hash ON public.auth_session(refresh_hash);

CREATE TABLE IF NOT EXISTS public.password_reset (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_password_reset_account ON public.password_reset(account_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash ON public.password_reset(token_hash);
