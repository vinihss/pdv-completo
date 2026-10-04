-- Central de alertas do app: o sino no header lista o que chegou (hoje, a
-- abertura de uma comanda) e o contador de "não visualizados" é persistido
-- aqui, não no cliente — o sino do garçom, do caixa e da cozinha precisa
-- continuar contando depois de um F5, com o tablet deitado na mesa.
--
-- `read_at` é global (não por usuário): o alerta responde "alguém do salão
-- já viu isso?", e quem marca é a tela da comanda (`OrderDetailScreen`).
--
-- `audience_roles` filtra quem recebe. NULL/vazio = todos os papéis; preenchido
-- = só os papéis listados. O mesmo recorte acontece no realtime, em rooms por
-- papel (`alerts`, `alerts:<role>`) — o servidor nunca publica num room que o
-- papel não consiga assinar (ver application/alert/alert.usecases.ts).
--
-- `order_id` com CASCADE: comanda é cancelada, nunca apagada, então o alerta
-- sobrevive à comanda e a listagem mostra o status dela ("encerrada").
--
-- IF NOT EXISTS: reexecutar a migration é seguro (o runner já pula arquivos
-- registrados em _migrations, mas o DDL não pode estourar se a tabela tiver
-- sido criada fora do runner). Alinhado com os 0003_*.

CREATE TABLE IF NOT EXISTS alert (
  id              TEXT PRIMARY KEY,
  -- `seq` (bigserial) é a ordem de inserção, e ela é obrigatória: `created_at`
  -- é TEXTO com precisão de milissegundo (o resto do schema também é), e duas
  -- comandas abertas no mesmo ms — exatamente o que acontece num rush — empatariam
  -- num ORDER BY só por `created_at`, e o sino passaria a listar em ordem
  -- aleatória. Mesma razão do `seq` em `outbox_event`.
  seq             BIGSERIAL NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'order_created',
  title           TEXT NOT NULL,
  body            TEXT,
  order_id        TEXT REFERENCES "order"(id) ON DELETE CASCADE,
  channel         TEXT,
  audience_roles  TEXT[],
  read_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- A listagem é sempre "os mais recentes primeiro" — pelo par (created_at, seq) —
-- e o filtro de não lidos precisa ser barato (é o que devolve o contador do sino).
CREATE INDEX IF NOT EXISTS idx_alert_created_at ON alert(created_at, seq);
CREATE INDEX IF NOT EXISTS idx_alert_unread ON alert(created_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_order ON alert(order_id);
