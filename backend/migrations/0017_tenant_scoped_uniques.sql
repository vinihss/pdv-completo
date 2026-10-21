-- 0017_tenant_scoped_uniques.sql - as UNIQUEs que eram GLOBAIS viram por LOJA
--
-- POR QUE
-- -------
-- A Fase 3 tira o schema-por-loja: as lojas passam a morar no mesmo schema
-- (`public`), separadas pela coluna `tenant_id` + a policy de RLS (a `0015`).
-- Ate a `0016` isso ja estava valido para a CHAVE PRIMARIA (que virou
-- `(tenant_id, id)`). Mas os indices UNIQUE continuaram GLOBAIS -- e um
-- indice global e uma lei de物理学 do schema unico:
--
--   - `user.email` unico no banco inteiro => a loja B nao pode ter um
--     `gerente@minhaloja.com.br` se a loja A tem o mesmo e-mail. O seed de
--     qualquer loja bate no `uq_user_email` e MORRE.
--   - `customer.cpf` / `customer.email` unicos no banco inteiro => o mesmo
--     CPF (que e global por natureza, mas o cliente e de UMA loja) colide
--     entre lojas.
--   - `order(channel, external_ref)` => o `external_ref` do pedido publico
--     (que e por loja) colide entre lojas.
--   - `provisioning_key(user_id) WHERE NOT revoked` => o mesmo usuario nao
--     pode ter chave de provisionamento ativa em duas lojas.
--   - `cash_drawer(status) WHERE status = 'open'` => so pode haver UM caixa
--     aberto... no banco inteiro. Com duas lojas, a loja B nao abre o caixa
--     porque a loja A tem um aberto.
--
-- Cada um desses e uma loja B que nao existe. O indice vira
-- `(tenant_id, <colunas>)`: a unicidade passa a ser DENTRO da loja, que e o
-- que o negocio quer ("o e-mail do usuario e unico NA MINHA LOJA").
--
-- O QUE ESTA MIGRATION FAZ
-- -----------------------
-- Recria os 6 indices UNIQUE com a `tenant_id` na frente. O `DROP` vem
-- antes do `CREATE` (o `CREATE UNIQUE INDEX` nao aceita `IF NOT EXISTS` com
-- uma definicao diferente). Os indices PARCIAIS (o `WHERE`) sao preservados:
-- eles existem para nao desperdicar espaco com as linhas que nao tem o
-- valor (CPF nulo, e-mail nulo, caixa fechado).
--
-- POR QUE ISSO NAO QUEBRA NADA
-- ----------------------------
-- A unica conclusao que muda e "agora DUAS lojas podem ter o mesmo
-- e-mail/CPF". Nenhuma query do app depende da unicidade global: o login
-- por e-mail e por conta GLOBAL (`public.account`, fora das policies), e a
-- busca de cliente por CPF/e-mail acontece DENTRO do escopo de tenant (a
-- policy de RLS ja limita a busca a loja). O indice continua sendo a
-- barreira contra o duplicado DENTRO da loja -- que e o que ele sempre
-- protegeu na pratica.
--
-- O `DROP` do indice antigo e seguro mesmo com dado duplicado: se duas
-- lojas tivessem o mesmo e-mail (impossivel antes, porque o indice global
-- barrava), o `CREATE` do indice novo aceitaria as duas. Nao ha, portanto,
-- janela em que o dado fica sem protecao.
--
-- O ROLLOUT
-- ---------
-- Esta migration e parte da Fase 3b (o runtime sem schema): sem ela, a
-- segunda loja bate no indice global no primeiro INSERT.

-- ---------------------------------------------------------------------------
-- Os indices recriados com a `tenant_id` na frente
-- ---------------------------------------------------------------------------

-- Só um caixa ABERTO por loja (a gaveta é da loja).
DROP INDEX IF EXISTS uq_cash_drawer_single_open;
CREATE UNIQUE INDEX uq_cash_drawer_single_open ON cash_drawer (tenant_id, status) WHERE (status = 'open');

-- O CPF e o e-mail do cliente sao unicos DENTRO da loja.
DROP INDEX IF EXISTS uq_customer_cpf;
CREATE UNIQUE INDEX uq_customer_cpf ON customer (tenant_id, cpf) WHERE (cpf IS NOT NULL);

DROP INDEX IF EXISTS uq_customer_email;
CREATE UNIQUE INDEX uq_customer_email ON customer (tenant_id, email) WHERE (email IS NOT NULL);

-- O `external_ref` do pedido publico e por loja (o id de canal + a referencia).
DROP INDEX IF EXISTS uq_order_channel_external_ref;
CREATE UNIQUE INDEX uq_order_channel_external_ref ON "order" (tenant_id, channel, external_ref);

-- Uma chave de provisionamento ativa por usuario, POR LOJA.
DROP INDEX IF EXISTS uq_provisioning_key_active;
CREATE UNIQUE INDEX uq_provisioning_key_active ON provisioning_key (tenant_id, user_id) WHERE (revoked_at IS NULL);

-- O e-mail do usuario e unico DENTRO da loja.
DROP INDEX IF EXISTS uq_user_email;
CREATE UNIQUE INDEX uq_user_email ON "user" (tenant_id, email) WHERE (email IS NOT NULL);
