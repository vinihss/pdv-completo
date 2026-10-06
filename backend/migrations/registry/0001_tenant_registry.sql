-- Registry de tenants — schema de CONTROLE, sempre `public`.
-- DDL de `docs/15-multi-tenant-schema.md` §3.2 (Fase 1 do §6).
--
-- ⚠️ ESTE DIRETÓRIO NÃO É LIDO PELO RUNNER DE MIGRATIONS DE TENANT.
-- `src/infra/db/migrate.ts` lê `migrations/*.sql` (um nível, só `.sql`), então
-- uma pasta dentro de `migrations/` fica de fora — e é por isso que ela é uma
-- pasta. Se este arquivo morasse em `migrations/`, ele rodaria dentro de CADA
-- schema de tenant quando a Fase 3 rodar `runMigrations({ schema })`: cada
-- loja ganharia sua própria lista de lojas, e o `slug` de uma resolveria para
-- o schema errado. O runner próprio é `src/infra/db/registry-migrate.ts`
-- (`runRegistryMigrations()`), que aplica SEMPRE em `public` — com
-- `SET LOCAL search_path = public` e toda referência qualificada, de modo que
-- nem uma conexão já apontada para um schema de tenant consiga desviar o DDL.
--
-- Por que `public`: é garantidamente o último elo de qualquer `search_path` do
-- projeto, inclusive o das conexões de tenant (§3.2 do doc 15).
--
-- O `CHECK` do `schema_name` NÃO é decoração: o nome do schema vem do registry,
-- nunca do request. Sem a barreira, um slug mal resolvido cai silenciosamente
-- em `public` — que é exatamente o modo de falha que o `pg` não acusa.

CREATE TABLE IF NOT EXISTS public.tenant (
  slug         TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  schema_name  TEXT NOT NULL UNIQUE CHECK (schema_name ~ '^tenant_[a-z0-9_]+$'),
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),

  -- Domínio próprio da loja (ex.: `umamisushiarte.com.br`), que NÃO é subdomínio
  -- do domínio da plataforma. Acrescentado ao DDL do §3.2 porque o primeiro
  -- cliente real (`umamisushiarte.com.br`) é justamente um domínio próprio, e
  -- a regra do §3.1 — "1ª label de um host com 3+ partes é o slug" — resolve o
  -- `umamisushiarte` (que não existe) e daria 404 numa loja que existe. Sem
  -- esta coluna o endpoint não teria como atender o caso que ele precisa
  -- atender. Não conflita com nada do §3.2: coluna nova, `NULL` por default
  -- (tenant por subdomínio não precisa dela), e o `CHECK`/`UNIQUE` do slug e do
  -- `schema_name` ficam intactos.
  --
  -- O índice é único por `lower(custom_domain)` (e não `UNIQUE` na coluna)
  -- porque host é case-insensitive: sem o `lower()`, `Loja.com.br` e
  -- `loja.com.br` poderiam existir como duas lojas disputando o mesmo endereço,
  -- e o `Host` do request não diria qual vence. O `CHECK` exige minúsculas
  -- para o valor gravado casar com o que o browser envia.
  custom_domain TEXT CHECK (
    custom_domain IS NULL
    OR custom_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),

  created_at   TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_custom_domain
  ON public.tenant (lower(custom_domain))
  WHERE custom_domain IS NOT NULL;

-- A extensão PRECISA morar em `public` (§5.1 do doc 15): sem isso o tenant 2
-- quebra com `function unaccent(unknown) does not exist`. Já está no baseline
-- `0001_init.sql:27`; aqui é `IF NOT EXISTS` de propósito, porque o registry roda
-- ANTES de qualquer migration de tenant (§6.1) e o passo continua valendo
-- quando o registry é o primeiro a tocar o banco.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
