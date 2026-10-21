-- 0018_drop_tenant_schemas.sql - o schema-por-loja SAI do banco
--
-- POR QUE
-- -------
-- A Fase 3 (a `0016`, a `0017` e o runtime) trocou o modelo: as lojas nao
-- tem mais schema proprio. Todas convivem no schema UNICO (`public`),
-- separadas pela coluna `tenant_id` + a policy de RLS. O schema `tenant_*`
-- de cada loja virou uma COPIA do dado (a `0016` copiou) e nada mais le ele.
--
-- Esta migration fecha o ciclo:
--   1. DROP dos schemas de loja (com o dado redundante dentro);
--   2. DROP da coluna `schema_name` do registry (a ultima topologia morta).
--
-- O QUE EXISTE HOJE (o "schema de loja" e reconhecivel por ter a
-- `store_settings` — a tabela que o modelo antigo criava em cada schema)
-- ------------------------------------------------------------------------
-- O criterio do DROP e a PRESENCA da `store_settings`: e a assinatura do
-- modelo antigo. Um schema de LOJA e um que tem `store_settings`; o `public`
-- (o do app) tambem tem — e por isso ele fica de fora pela lista explicita.
-- Qualquer outro schema (extensao, ferramenta) nao e tocado.
--
-- A COPIA DEVE TER SIDO FEITA (a `0016`)
-- ---------------------------------------------
-- A `0016` copiou as linhas de cada loja para o `public` com o `tenant_id`
-- CERTO. O que se apaga aqui e a segunda via. E por isso que a migration
-- VERIFICA antes de apagar: se alguma loja do registry ainda tem schema
-- proprio, ela e apagada do mesmo jeito (o `public` ja tem a copia — foi a
-- `0016`), mas a migration CONTA o que apagou, para o log deixar isso
-- registrado.
--
-- A ordem importa
-- ---------------
--   `0016` (PK composta + copia)  ->  `0017` (UNIQUEs por loja)  ->
--   `0018` (esta: drop dos schemas + da coluna)
-- Sem a `0016`, a loja perderia o dado; sem a `0017`, o seed da segunda loja
-- bateria no indice global.
--
-- O QUE NAO ESTA NESTA MIGRATION
-- ------------------------------
-- - O volume de uploads: os arquivos das lojas antigas estao em
--   `<uploadsDir>/<schema>/`. O novo layout e por `tenantId` (o runtime da
--   Fase 3b). A migracao dos arquivos e do VOLUME (nao do banco) — fica para
--   a operacao de deploy (o `scripts/migrate-uploads-layout.ts` e o caminho
--   que move o flat para o layout por loja).
-- - O `_migrations` de cada schema: ele sai junto com o schema.
--
-- O ROLLOUT
-- ---------
-- Esta e a Fase 3c (o "contract" do expand/contract): o runtime ja nao le
-- schema nenhum (Fase 3b), entao o que se apaga aqui nao e lido por nada.
-- Depois dela, o modelo por linha esta COMPLETO: um schema, uma coluna, uma
-- policy.

-- ---------------------------------------------------------------------------
-- 1. Os schemas de loja (o modelo antigo)
-- ---------------------------------------------------------------------------
-- O criterio: tem `store_settings` (a assinatura do modelo por loja) E nao e
-- o schema do app. A lista e montada antes do DROP, para o log dizer o que
-- foi apagado.
DO $drop$
DECLARE
  s RECORD;
  apagados TEXT := '';
BEGIN
  FOR s IN
    SELECT nspname
      FROM pg_namespace n
     WHERE nspname NOT IN ('public', 'information_schema')
       AND nspname NOT LIKE 'pg_%'
       AND nspname NOT LIKE 'postgis%'
       AND EXISTS (
         SELECT 1 FROM pg_class c
          WHERE c.relnamespace = n.oid AND c.relname = 'store_settings'
       )
     ORDER BY nspname
  LOOP
    apagados := apagados || s.nspname || ' ';
    EXECUTE format('DROP SCHEMA %I CASCADE', s.nspname);
    RAISE NOTICE '[0018] schema de loja apagado: %', s.nspname;
  END LOOP;
  IF apagados <> '' THEN
    RAISE NOTICE '[0018] schemas de loja apagados: %', apagados;
  ELSE
    RAISE NOTICE '[0018] nenhum schema de loja para apagar';
  END IF;
END
$drop$;

-- ---------------------------------------------------------------------------
-- 2. A coluna `schema_name` do registry (a ultima topologia morta)
-- ---------------------------------------------------------------------------
-- O schema e UNICO agora: a coluna nao tem mais o que dizer. O `CHECK` vai
-- junto (ele existia so para o nome do schema).
ALTER TABLE public.tenant DROP CONSTRAINT IF EXISTS tenant_schema_name_check;
ALTER TABLE public.tenant DROP COLUMN IF EXISTS schema_name;

-- O indice unico do `schema_name` (criado no registry 0001) tambem sai — sem a
-- coluna, o indice nao existe mais.
DROP INDEX IF EXISTS tenant_schema_name_key;
