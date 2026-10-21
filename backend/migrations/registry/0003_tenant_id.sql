-- Workstream B (multi-tenant por LINHA): o registry ganha `id` (uuid) e passa a
-- ter uma LINHA para o tenant default.
--
-- POR QUE ESTE ARQUIVO EXISTE
-- --------------------------
-- O modelo vigente isola as lojas por SCHEMA (`tenant_<slug>`): pool dedicado,
-- `search_path` fixado no startup packet, migrations aplicadas uma vez por
-- loja. O modelo do workstream B isola por LINHA: um schema só, toda tabela de
-- negócio com `tenant_id`, e a barreira no próprio Postgres (RLS).
--
-- Nos dois modelos o tenant precisa de uma identidade ESTÁVEL e independente
-- do schema: o `slug` serve (é o claim do JWT e a 1ª label do Host), mas o
-- `tenant_id` que vai para a coluna e para as policies tem que ser um id — um
-- slug pode ser renomeado, um id não. Por isso `public.tenant` ganha `id`.
--
-- O QUE ESTE ARQUIVO FAZ (sem mudar comportamento)
-- ------------------------------------------------
--  1. `public.tenant` ganha `id uuid` (PK); `slug` passa a ser UNIQUE.
--  2. `schema_name` deixa de ser NOT NULL e o CHECK passa a aceitar `public`
--     (e NULL) — o tenant default vive no schema `public`.
--  3. A LINHA do tenant default é criada (slug `default`).
--
-- POR QUE O DEFAULT VIRA LINHA
-- ----------------------------
-- Hoje o default NÃO é uma linha do registry: ele é o ambiente
-- (`DEFAULT_TENANT_SCHEMA`), e é por isso que a CLI (`pdv db list`) devolvia
-- "nenhum tenant encontrado" no dev e que o backfill do dado existente não
-- tinha a quem carimbar. A partir daqui o default tem id próprio — e é esse
-- id que vai carimbar toda linha de dado existente na fase de backfill.
--
-- O `id` do default é FIXO (`…0001`) para que o backfill e os seeds sejam
-- reprodutíveis e para que o caminho "sem escopo ALS" (trabalhos internos,
-- `requireTenant()`) use exatamente o mesmo id do tenant default.
--
-- O roteamento NÃO muda aqui: o schema-por-tenant continua valendo até a fase
-- em que o pool vira único. Este arquivo é só o alicerce do id.
--
-- O CHECK de `schema_name` (nome de schema) e o `UNIQUE` continuam valendo
-- para as lojas com schema dedicado; `NULL` é aceito porque o modelo por
-- linha não tem schema — e `NULL` não conflita no `UNIQUE` do Postgres.

-- 1) id uuid no registry
ALTER TABLE public.tenant ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
UPDATE public.tenant SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE public.tenant ALTER COLUMN id SET NOT NULL;

-- 2) slug deixa de ser PK e vira UNIQUE; id vira PK
ALTER TABLE public.tenant DROP CONSTRAINT IF EXISTS tenant_pkey;
ALTER TABLE public.tenant ALTER COLUMN slug SET NOT NULL;
ALTER TABLE public.tenant ADD CONSTRAINT tenant_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_slug ON public.tenant(slug);

-- 3) schema_name: deixa de ser obrigatório e passa a aceitar o schema default
ALTER TABLE public.tenant ALTER COLUMN schema_name DROP NOT NULL;
ALTER TABLE public.tenant DROP CONSTRAINT IF EXISTS tenant_schema_name_check;
ALTER TABLE public.tenant ADD CONSTRAINT tenant_schema_name_check
  CHECK (schema_name IS NULL OR schema_name = 'public' OR schema_name ~ '^tenant_[a-z0-9_]+$');

-- 4) a linha do tenant default
INSERT INTO public.tenant (id, slug, schema_name, display_name, status, custom_domain)
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'public', 'Padrão', 'active', NULL)
ON CONFLICT (slug) DO NOTHING;
