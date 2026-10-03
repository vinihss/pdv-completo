-- ============================================================
-- 0011_store_settings_per_store — uma linha de `store_settings` POR store.
--
-- `store_settings` nasceu como singleton: a PK é `id` DEFAULT 'singleton' e
-- todo o código lia `WHERE id = 'singleton'`. A 0008 adicionou
-- `store_settings.store_id` e o `getStoreSettingsUsecase` já busca por ele,
-- mas nenhuma store além da default tinha linha — a loja `ana-terra`
-- (0010) abria 404 em GET /store-settings.
--
-- O que esta migration faz (e o que NÃO faz):
--   ✓ garante 1 linha por store (INSERT para toda store sem settings);
--   ✓ UNIQUE em `store_id` (uq_store_settings_store) — a garantia de "1 por
--     store" passa a ser do banco, não da aplicação;
--   ✗ NÃO dropa a PK `id` nem a DEFAULT 'singleton' (a versão antiga do app
--     continua lendo `WHERE id = 'singleton'` — expand/contract);
--   ✗ NÃO faz NOT NULL em `store_id` (coluna já populada pelo backfill da
--     0008 e nullable por design: FK ON DELETE SET NULL).
--
-- Idempotente: pode rodar de novo sem efeito (IF NOT EXISTS / checagem de
-- constraint / WHERE NOT EXISTS). O boot aborta se qualquer passo falhar.
--
-- ATENÇÃO para quem criar store NOVA: esta migration roda UMA vez
-- (`_migrations`), então ela não vai recriar settings de uma store que nascer
-- depois. Copie o bloco do passo 2 para a migration que cria a store:
--
--   INSERT INTO store_settings (id, store_id, merchant_name, merchant_city)
--   SELECT s.id, s.id, left(s.name, 25), ''
--     FROM stores s
--    WHERE s.id = '<id-da-store>'
--      AND NOT EXISTS (SELECT 1 FROM store_settings ss WHERE ss.store_id = s.id)
--   ON CONFLICT (id) DO NOTHING;
--
-- (o `npm run seed` também preenche o que faltar — ver `ensureStoreSettings`).
-- ============================================================

-- ---------------------------------------------------------------- 0) store_id preenchido
-- Backfill da 0008 já fez isso; repetir aqui cobre linha criada entre a 0008
-- e esta migration (a coluna continua nullable, então é só higiene antes da
-- unique).
UPDATE store_settings
   SET store_id = '00000000-0000-0000-0000-000000000001'
 WHERE store_id IS NULL;

-- ---------------------------------------------------------------- 1) dedupe defensivo
-- Duas linhas para a MESMA store fariam o ADD CONSTRAINT falhar (e o boot
-- abortar). Não devem existir — o código nunca escreveu settings por store —
-- mas se existirem, fica a mais antiga (menor ctid = inserida primeiro) e as
-- demais saem. Só atinge linhas que já disputam a mesma store_id.
DELETE FROM store_settings a
 USING store_settings b
WHERE a.store_id IS NOT NULL
  AND a.store_id = b.store_id
  AND a.ctid > b.ctid;

-- ---------------------------------------------------------------- 2) settings para toda store sem linha
-- `id` da linha nova = o próprio store_id, EXCETO a store default, que
-- mantém o id histórico 'singleton': os UPDATEs raw (testes, scripts de
-- suporte) e qualquer dado legado apontam para esse id. A PK `id` continua
-- existindo — não é dropada.
-- Os demais campos vêm dos DEFAULTs explícitos do schema (0001/0003/0006/
-- 0007), nunca do valor que a aplicação "esqueceria" de mandar.
INSERT INTO store_settings (id, store_id, merchant_name, merchant_city)
SELECT CASE WHEN s.id = '00000000-0000-0000-0000-000000000001'
            THEN 'singleton'
            ELSE s.id
       END,
       s.id,
       -- merchant_name tem limite de 25 na tela de Configurações (o usecase
       -- valida <= 25 no PUT): nascer acima disso deixaria a loja sem poder
       -- salvar nada até cortar o nome.
       left(s.name, 25),
       ''  -- cidade fica pra o dono preencher (é ela que alimenta o geocoding)
  FROM stores s
 WHERE NOT EXISTS (SELECT 1 FROM store_settings ss WHERE ss.store_id = s.id)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- 3) UNIQUE em store_id
-- É a constraint que garante "1 linha de settings por store". Antes de criar,
-- o passo 1 garante que não há dado violando; depois disso, qualquer INSERT
-- concorrente de duas instâncias subindo ao mesmo tempo converge para uma
-- única linha (o advisory lock do runner de migrations já serializa, na prática).
DO $$
BEGIN
  ALTER TABLE store_settings
    ADD CONSTRAINT uq_store_settings_store UNIQUE (store_id);
EXCEPTION
  -- 42710 duplicate_object: a constraint já existe (reexecução da migration).
  -- 42P07 duplicate_table: já existe índice com esse nome — a unicidade já
  -- está garantida nesse caso, então não é erro.
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table  THEN NULL;
END $$;
