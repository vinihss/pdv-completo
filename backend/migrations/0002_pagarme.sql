-- ============================================================
-- Migration 0008 — Pagar.me V5 (cobrança no gateway).
--
-- O que entra, e POR QUÊ três tabelas e não uma:
--
--   - `payment`        a COBRANÇA no gateway: 1 linha por tentativa de
--                      pagamento de uma comanda (order_id + attempt). É o
--                      espelho local do "order/charge" do Pagar.me, com os
--                      ids externos (or_/ch_/pay_) para reconciliar.
--   - `payment_event`  a INBOX do webhook. O Pagar.me reenvia o MESMO
--                      evento enquanto não receber 200 (o `event_id` é a
--                      chave), então a linha é gravida ANTES do 200 e o
--                      processamento acontece depois, por worker, com o
--                      advisory lock. Isso substitui a fila com broker que a
--                      spec pedia: este repo não tem broker (deploy é
--                      blue/green, tudo in-process), então a fila é a própria
--                      tabela.
--   - `payment_refund` os ESTORNOS, um por pedido de estorno — parcial ou
--                      integral. `payment.refunded_amount` é o acumulado; a
--                      linha é o histórico (e a rastreabilidade do
--                      refund_id do gateway).
--
-- ## NÃO é multi-tenant
--
-- O PLANO_PAGARME.md da raiz propõe `stores`, `store_id` em tudo e split por
-- recebedor em PRs separados. Nada disso existe no banco hoje: `store_settings`
-- é singleton e não existe coluna `store_id` em lugar nenhum. Esta migration
-- é deliberadamente de escopo estreito — não cria `stores`, não adiciona
-- `store_id`, não faz onboarding de recebedor. Split (que a doc oficial mostra
-- ser POR PAGAMENTO, `payments[].split[]`, e não o `split_rules` que o plano
-- supõe) fica isolado no mapper, comentado, para um PR próprio.
--
-- ## Tipos: mesmos do resto do schema (ver o cabeçalho de schema.ts)
--
-- PK `text`, timestamps `text` ISO-8601 UTC (ordenação lexicográfica =
-- cronológica), JSON em `text`, dinheiro em REAL (reais — o node-postgres
-- devolveria string em NUMERIC e quebraria round2/moneyEq). Os CENTAVAS só
-- existem na borda do Pagar.me, dentro de integrations/pagarme/mapper.ts.
--
-- `DEFAULT gen_random_uuid()` no id: o app gera o id em `crypto.randomUUID()`
-- (função `id()` do schema.ts), então o default é só a rede de segurança para
-- escrita fora do app — raw SQL, seed, conciliação manual. `gen_random_uuid`
-- é nativo do Postgres 13+ (não precisa de pgcrypto), e o alvo aqui é 16.
--
-- `status` é TEXT, não enum: o status vem do EXTERNO e a doc do Pagar.me não
-- o enumera. Um enum local quebraria no primeiro status novo que o gateway
-- inventar — exatamente a razão de `whatsapp_inbound_message.type` ser TEXT
-- (ver migration 0002). O mapper devolve `null` para valor desconhecido em vez
-- de chutar, e quem chama decide o que fazer.
--
-- IF NOT EXISTS / expand-safe: reexecutar é seguro e a versão antiga do backend
-- continua funcionando — ela não conhece nenhuma dessas tabelas nem a coluna
-- nova de store_settings.
-- ============================================================

-- ---------------------------------------------------------------- cobranças
CREATE TABLE IF NOT EXISTS payment (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 TEXT NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  -- Numeração da tentativa (1, 2, 3...): "essa comanda já foi cobrada uma vez e
  -- o cliente mandou outro Pix" é um SEGUNDO pagamento, não uma sobrescrita.
  attempt                  INTEGER NOT NULL DEFAULT 1,
  provider                 TEXT NOT NULL,                          -- 'pagarme'
  -- IDs externos são SEMPRE string. A doc do V5 usa prefixo por tipo (`or_`
  -- pedido, `ch_` charge, `pay_` pagamento): guardar como número perderia o
  -- prefixo e a comparação com o webhook deixaria de bater.
  provider_order_id        TEXT,
  provider_charge_id       TEXT,
  provider_payment_id      TEXT,
  -- Só o que o gateway faz: 'pix' | 'credit_card'. O enum `payment_method` do
  -- repo é o do balcão (cash/card/pix/other) e pertence a `order_payment`.
  method                   TEXT NOT NULL,
  amount                   REAL NOT NULL,                          -- CHECK > 0
  currency                 TEXT NOT NULL DEFAULT 'BRL',
  status                   TEXT NOT NULL DEFAULT 'pending',
  -- Acumulado dos estornos. O CHECK amarra ao amount: estornar mais do que foi
  -- cobrado é sempre erro de bug/concorrência, não estado legítimo.
  refunded_amount          REAL NOT NULL DEFAULT 0,
  failure_reason           TEXT,
  -- QR do GATEWAY. O repo já tem QR PIX local (BR Code gerado no client, ver
  -- docs/11-pix-pendencias.md) que é a chave estática da loja; este é o QR da
  -- COBRANÇA, com txid e expiração próprios. Os dois coexistem e não se
  -- confundem — a doc do Pagar.me é omissa sobre onde esse QR vem no corpo da
  -- criação (ver mapper.ts), então as colunas são nullable.
  qr_code                  TEXT,
  qr_code_base64           TEXT,
  qr_code_url              TEXT,
  pix_txid                 TEXT,
  pix_expires_at           TEXT,
  paid_at                  TEXT,
  canceled_at              TEXT,
  metadata                 TEXT NOT NULL DEFAULT '{}',             -- JSON string
  created_at               TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at               TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),

  CONSTRAINT chk_payment_amount        CHECK (amount > 0),
  CONSTRAINT chk_payment_refunded      CHECK (refunded_amount >= 0 AND refunded_amount <= amount)
);

-- Uma comanda tem uma lista de cobranças (idx_payment_order) e a lista de
-- "o que ainda está esperando o cliente" sai daqui (idx_payment_status).
CREATE INDEX IF NOT EXISTS idx_payment_order ON payment(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_status ON payment(status);

-- O webhook chega com o id do pagamento (`pay_`/`ch_`), não com o nosso id, e
-- é por ele que o evento acha a linha para atualizar.
CREATE INDEX IF NOT EXISTS idx_payment_provider_payment_id ON payment(provider_payment_id);

-- A trava de idempotência estrutural: duas cobranças para a MESMA tentativa
-- são impossível no banco, sem depender de todo caminho de criação lembrar de
-- checar. `withIdempotency` (http/middlewares/idempotency.middleware.ts)
-- resolve o retry do MESMO request; este índice resolve o "dois requests
-- diferentes convergentem para a mesma tentativa". Não existe tabela
-- `payment_operations` da spec: a unicidade aqui é o que ela faria.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_order_attempt ON payment(order_id, attempt);

-- ---------------------------------------------------------------- inbox do webhook
-- Gravada ANTES do HTTP 200 (o mesmo desenho de `ifood_event`: o provedor
-- reenvia o evento enquanto não recebe 200, então persistir depois do ACK
-- perde evento).
CREATE TABLE IF NOT EXISTS payment_event (
  id                 TEXT PRIMARY KEY,
  -- Ordem de inserção. `created_at` é texto com precisão de milissegundo e dois
  -- eventos no mesmo ms empatariam num ORDER BY só por ele — mesma razão do
  -- `seq` de outbox_event/alert/stock_movement.
  seq                BIGSERIAL NOT NULL,
  provider           TEXT NOT NULL,
  event_id           TEXT NOT NULL,                              -- id do Pagar.me
  event_type         TEXT NOT NULL,
  -- payment_id é NULL enquanto o evento não casou com uma cobrança nossa
  -- (evento de outro pedido, ou de um pedido que nem criamos). SET NULL: o
  -- evento NÃO pode ser apagado junto com a cobrança — é a prova do que o
  -- gateway mandou, e o worker ainda precisa dele.
  payment_id         TEXT REFERENCES payment(id) ON DELETE SET NULL,
  provider_order_id  TEXT,
  provider_payment_id TEXT,
  payload            TEXT NOT NULL,                              -- JSON string cru
  status             TEXT NOT NULL DEFAULT 'received',           -- received|processing|processed|ignored|failed
  attempts           INTEGER NOT NULL DEFAULT 0,
  processed_at       TEXT,
  error_message      TEXT,
  -- Backoff do worker: NULL = elegível agora.
  next_attempt_at    TEXT,
  created_at         TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- A idempotência do webhook: o mesmo event_id do mesmo provider entra uma vez
-- só, e o reenvio colide no índice em vez de duplicar pagamento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_event_provider_event_id
  ON payment_event(provider, event_id);

CREATE INDEX IF NOT EXISTS idx_payment_event_status_next ON payment_event(status, next_attempt_at);
-- Um índice só, e composto: o ciclo do worker pergunta "status IN
-- ('received','failed') E next_attempt_at vencido" — a coluna de status na
-- frente faz o filtro ser resolvido no índice e a de data segura a faixa.
-- (Não é parcial como o do outbox: aqui `failed` também é pendente, então o
-- predicado seria uma lista que muda com cada status novo.)
CREATE INDEX IF NOT EXISTS idx_payment_event_payment ON payment_event(payment_id);

-- ---------------------------------------------------------------- estornos
CREATE TABLE IF NOT EXISTS payment_refund (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          TEXT NOT NULL REFERENCES payment(id) ON DELETE CASCADE,
  amount              REAL NOT NULL,                              -- CHECK > 0
  provider_refund_id  TEXT,
  -- requested (pedido, ainda sem resposta) → succeeded | failed. A linha é
  -- escrita ANTES da chamada ao gateway: é o que impede um "estornei e não
  -- sei" quando a resposta se perde, porque o próximo ciclo reconcilia por
  -- status em vez de confiar na memória do processo.
  status              TEXT NOT NULL DEFAULT 'requested',
  reason              TEXT,
  requested_by        TEXT REFERENCES "user"(id),
  requested_at        TEXT,
  settled_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at          TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),

  CONSTRAINT chk_payment_refund_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_payment_refund_payment ON payment_refund(payment_id);

-- ---------------------------------------------------------------- master switch
-- Opt-in por loja, mesmo desenho do `whatsapp_integration_enabled` (0007): o
-- painel de pagamento no gateway só existe para quem liga o toggle. DEFAULT
-- false de propósito — nenhuma instalação existente passa a cobrar no gateway
-- sem alguém decidir isso.
ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS pagarme_enabled BOOLEAN NOT NULL DEFAULT false;