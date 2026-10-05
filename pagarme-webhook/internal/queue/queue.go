// Package queue drena a inbox de `payment_event`: pega os eventos elegíveis e
// pede ao backend Node que aplique a cobrança.
//
// ## Onde está cada metade
//
// ESTE serviço tem: a seleção do que processar (`received` elegível ou `failed`
// com backoff vencido), o `attempts`, o `next_attempt_at`, o backoff, a DLQ e o
// advisory lock que serializa instâncias. São as quatro coisas que são I/O e
// temporização.
//
// O Node tem: o que o evento SIGNIFICA (`applyCharge`, `bridgePaidToOrder`,
// `audit_log`, `outbox_event`). É regra de domínio e é dele.
//
// A divisão é o que impede duas implementações da regra financeira divergindo
// contra o mesmo banco. E é por isso que a entrega é at-least-once: quem decide
// se o efeito já aconteceu é o Node, dentro da transação dele.
//
// ## Por que não há RabbitMQ
//
// A spec §23 pedia exchange/queues/DLQ. Este repo não tem broker, o deploy é
// blue/green e o resultado da fila é justamente a tabela `payment_event`, que o
// endpoint já grava ANTES do 200. Um broker aqui seria uma dependência de infra
// nova para consumir uma fila que o Postgres já é. O que a spec pede — evento
// persistido antes do processamento, processamento assíncrono, retry, DLQ — está
// todo aqui.
//
// ## Cadência
//
// A inbox drena a cada 2s (um webhook de pagamento é evento de baixa frequência
// por natureza: o pico é o fechamento do expediente) e a reconciliação a cada
// `PAGARME_RECONCILIATION_INTERVAL_MS` (10min por padrão, spec §22). Mesmos
// números do `worker.ts` de propósito.
package queue

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"pdv-pagarme-webhook/internal/charge"
	"pdv-pagarme-webhook/internal/inbox"
	"pdv-pagarme-webhook/internal/nodeapi"
)

const (
	// PollMS e BatchSize espelham `worker.ts` (WEBHOOK_POLL_MS=2000, BATCH=25).
	// Mesmos números de propósito: mudar aqui e não lá muda a latência da
	// confirmação de pagamento e a pressão no banco.
	PollMS    = 2000
	BatchSize = 25

	// MaxAttempts é o teto de tentativas, o `MAX = 5` do
	// `requeueFailedEventUsecase` (payment.usecases.ts:705). Estourado o teto o
	// evento PARA de ser reprocessado e fica em `failed` sem
	// `next_attempt_at` — que é a DLQ.
	MaxAttempts = 5

	// backoffBaseMS e backoffTetoMS são as duas constantes do backoff do Node:
	// `Math.min(2 ** attempts * 30_000, 15 * 60_000)`.
	backoffBaseMS = 30_000
	backoffTetoMS = 15 * 60_000

	// lockWorker é o nome do advisory lock, e tem que ser a MESMA string de
	// `LOCKS.paymentWorker` (`backend/src/infra/locks.ts:44`). Um caractere
	// diferente é OUTRO lock: os dois workers passam a rodar em paralelo, cada um
	// num lock que não enxerga o outro, e a exclusão mútua que existe para
	// proteger o lote simplesmente deixa de existir — sem erro em lugar nenhum.
	//
	// `hashtext('pdv:payment:worker')` e `hashtext('pdv:payment:worker ')` (espaço
	// a mais) dariam locks DIFERENTES. Daí o literal morar aqui e numa nota.
	lockWorker = "pdv:payment:worker"

	// lockReconciliation é `LOCKS.paymentReconciliation`. Lock SEPARADO do
	// worker de propósito: reconciliação e drain são trabalhos diferentes, e
	// disputarem o mesmo lock significaria um ciclo de reconciliação
	// atrasando o webhook (ou o contrário) sem necessidade.
	lockReconciliation = "pdv:payment:reconciliation"
)

// Backoff é o atraso antes da próxima tentativa, espelhando o Node.
//
// `min(2^attempts * 30s, 15min)` com `attempts` JÁ INCREMENTADO (o Node
// incrementa em `processPaymentEventUsecase` antes de reenfileirar). A
// sequência com `MaxAttempts = 5` é 60s, 120s, 240s, 480s, e a quinta falha vai
// para a DLQ. O teto de 15min nunca é alcançado nesse intervalo — ele existe
// porque o Node tem, e mudar a curva aqui e não lá mudaria o comportamento
// observável da fila.
//
// O `2^attempts` cresce geométrica e não linear porque o erro que leva a retry é
// quase sempre transitório (Node reiniciando, banco ocupado) e some em segundos —
// e martelar de 2 em 2s com uma caixa fora seria o jeito de transformar uma
// indisponibilidade curta em uma leva de requisições.
func Backoff(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	// `2^attempts`, com deslocamento em vez de `math.Pow` — o expoente é
	// pequeno (o teto de tentativas é 5) e o inteiro não transborda no caminho
	// normal, enquanto `math.Pow` devolveria um float e o teto comparia float com
	// int.
	//
	// O corte em 20 é o que segura o transbordo: `int64 << 62` zera a variável
	// (o bitoverflow sai pela esquerda), e um `Backoff` que devolvesse 0 viraria
	// laço apertado de retry — o oposto do que a função existe para evitar. Com o
	// teto de tentativas em 5, o desvio de um `attempts` absurdo aqui é
	// inexistente; o corte existe para o `attempts` vir de dado corrompido.
	const corte = 20
	if attempts > corte {
		return backoffTetoMS * time.Millisecond
	}
	ms := int64(backoffBaseMS) << attempts
	if ms > backoffTetoMS {
		ms = backoffTetoMS
	}
	return time.Duration(ms) * time.Millisecond
}

// eventRow é uma linha elegível da inbox.
type eventRow struct {
	id        string
	eventID   string
	eventType string
	payload   string
	attempts  int
}

// Aplica é o que o drain precisa saber fazer. Interface mínima para poder
// testar o drain inteiro sem subir HTTP nem Postgres: o `*nodeapi.Client`
// satisfaz, e um dublê em teste também.
type Aplica interface {
	ApplyEvent(ctx context.Context, eventRowID string, req nodeapi.Request) (nodeapi.Result, error)
	ApplyCharge(ctx context.Context, req nodeapi.Request) (nodeapi.Result, error)
}

// Drainer drena a inbox.
type Drainer struct {
	db     *sql.DB
	aplica Aplica
	poll   time.Duration
	batch  int
	now    func() time.Time
}

// New monta um Drainer.
func New(db *sql.DB, aplica Aplica) *Drainer {
	return &Drainer{db: db, aplica: aplica, poll: PollMS * time.Millisecond, batch: BatchSize, now: time.Now}
}

// Run faz o polling até o ctx ser cancelado.
//
// Com `PAGARME_DRAIN` desligado ele registra por que está inativo e volta sem
// tocar no banco nem no Node — o worker do Node é quem processa nesse caso.
// Ver gate.go antes de mexer em qualquer coisa aqui.
//
// Nenhum erro de ciclo derruba o processo: um banco oscilando por 5 segundos não
// pode levar o webhook junto, e o `Run` do `worker.ts` faz o mesmo (regra 1.5).
// O erro sai no log, que é o que o operador lê.
func (d *Drainer) Run(ctx context.Context) {
	if !DrainEnabled() {
		LogDrainInativo("PAGARME_DRAIN desligado")
		return
	}

	ticker := time.NewTicker(d.poll)
	defer ticker.Stop()

	// Um ciclo no boot, antes do primeiro tick: sem isso, um evento que chegou
	// durante a subida espera 2s para ser processado sem motivo nenhum.
	if _, err := d.DrainOnce(ctx); err != nil && ctx.Err() == nil {
		log.Printf("[queue] erro no primeiro ciclo da inbox: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			log.Println("[queue] drain da inbox parado")
			return
		case <-ticker.C:
			if _, err := d.DrainOnce(ctx); err != nil && ctx.Err() == nil {
				log.Printf("[queue] erro no ciclo da inbox: %v", err)
			}
		}
	}
}

// selectStmt é a consulta de elegibilidade.
//
// O predicado é o do Node (`drainInboxOnce`, worker.ts:99), palavra por palavra:
//
//	(status = 'received' AND next_attempt_at IS NULL)   -- novo, ou reenfileirado
//	OR (status = 'failed' AND next_attempt_at <= $1)    -- backoff vencido
//
// `ORDER BY seq ASC` e não `created_at`: `seq` é BIGSERIAL e não empata, enquanto
// `created_at` é texto com precisão de milissegundo — dois eventos no mesmo ms
// teriam ordem indefinida, e a ordem de aplicação de "pago" e "estornado" no
// mesmo instante muda o resultado final da cobrança.
//
// ## `processing` fica de fora de propósito
//
// Um evento marcado `processing` que o processo não terminou é resgatado pela
// reconciliação. Pegá-lo aqui criaria dois consumidores da mesma linha ao mesmo
// tempo — e como o apply é at-least-once e roda no Node, o que se overlaparia é
// Duas transações de `applyCharge` na mesma cobrança, com o
// `paymentConfirmedAt` e a linha de `order_payment` divididos entre elas.
const selectStmt = `SELECT id, event_id, event_type, payload, attempts
	FROM payment_event
	WHERE (status = 'received' AND next_attempt_at IS NULL)
	   OR (status = 'failed' AND next_attempt_at <= $1)
	ORDER BY seq ASC
	LIMIT $2`

// DrainOnce é um ciclo da inbox.
//
// ## O que o advisory lock garante, e o que não
//
// O ciclo inteiro roda dentro do advisory lock de TRANSAÇÃO (`pdv:payment:worker`,
// a MESMA chave do worker do Node): se outro processo já está drenando, este
// ciclo pula em silêncio em vez de disputar as mesmas 25 linhas a cada 2s. O que
// ele garante é MÚTUA EXCLUSÃO entre drenadores — inclusive entre este serviço e
// o worker do Node, que continuam coexistindo durante a migração sem nunca
// processar a mesma linha ao mesmo tempo.
//
// O que ele NÃO garante é quem "é o dono" do webhook: quem decide isso é o Caddy
// (ver `deploy/Caddyfile` §`handle /webhooks/pagarme`). Um drenador que não está
// no caminho do HTTP ainda assim processa a fila — e isso é CORRETO aqui, ao
// contrário do realtime: os dois drenadores entregam ao MESMO endpoint interno do
// Node, que é idempotente. Não existe aqui o defeito do `WS_DISPATCH` (gateway que
// marca `published = true` sem ninguém ter recebido), porque ninguém "marca" nada
// como entregue sem a transação do Node ter rodado.
//
// `pg_try_advisory_xact_lock` e NUNCA `pg_try_advisory_lock`: o lock de sessão
// ficaria preso na conexão ociosa do pool (o `database/sql` não faz pin de
// conexão), as queries seguintes cairiam em outras conexões e não enxergariam o
// lock. O lock de transação é liberado no COMMIT/ROLLBACK, que é a garantia que
// o código precisa. Ver a nota em `backend/src/infra/locks.ts` e a justificativa
// medida em `ws-gateway/internal/outbox/outbox.go:129`.
func (d *Drainer) DrainOnce(ctx context.Context) (int, error) {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() // no-op se já commitou

	var locked bool
	if err := tx.QueryRowContext(ctx,
		`SELECT pg_try_advisory_xact_lock(hashtext($1))`, lockWorker).Scan(&locked); err != nil {
		return 0, err
	}
	if !locked {
		// Lock ocupado não é erro: é o desenho. A tentativa é de graça (`try_`),
		// então custa uma query a cada 2s.
		return 0, nil
	}

	agora := inbox.NowISO(d.now())
	rows, err := tx.QueryContext(ctx, selectStmt, agora, d.batch)
	if err != nil {
		return 0, err
	}

	var lote []eventRow
	for rows.Next() {
		var e eventRow
		if err := rows.Scan(&e.id, &e.eventID, &e.eventType, &e.payload, &e.attempts); err != nil {
			rows.Close()
			return 0, err
		}
		lote = append(lote, e)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	for _, e := range lote {
		d.process(ctx, tx, e)
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(lote), nil
}

// process trata UM evento: aplica no Node ou reagenda.
//
// Não devolve erro. Um evento que falha não pode abortar o lote — os outros 24
// precisam ser vistos, e o erro do evento já vai para `error_message`, que é onde
// o operador olha.
func (d *Drainer) process(ctx context.Context, tx *sql.Tx, e eventRow) {
	charge, err := cargaDe(e.payload)
	if err != nil {
		// Payload que o mapper não entende. Terminal de propósito: o mesmo
		// payload vai falhar em toda tentativa, e a reconciliação do pagamento
		// (que relê o gateway por `GET /orders/{id}`) é quem resolve.
		d.marcarTerminal(ctx, tx, e, "failed", "payload inválido: "+err.Error())
		return
	}

	req := nodeapi.Request{
		EventID:           e.id,
		EventType:         e.eventType,
		ProviderOrderID:   charge.ProviderOrderID,
		ProviderPaymentID: charge.ProviderPaymentID,
		Source:            nodeapi.SourceEvent,
		Charge:            nodeapi.NewChargePayload(charge),
	}

	res, err := d.aplica.ApplyEvent(ctx, e.id, req)
	if err == nil {
		// Sucesso: o Node já marcou a linha como `processed` (ou `ignored`) na
		// TRANSAÇÃO DELE, dentro do `processPaymentEventUsecase`. Este processo
		// não escreve status de sucesso — e não é omissão: são dois donos
		// Deliberados da mesma linha, e o dono do estado final é quem aplica.
		if !res.Applied && res.Reason != "" {
			log.Printf("[queue] evento %s (%s) não aplicado: %s", e.eventID, e.eventType, res.Reason)
		}
		return
	}

	d.tratarErro(ctx, tx, e, err)
}

// tratarErro é a tabela de destino de uma falha.
//
//	Cada linha decide um destino diferente, e o destino errado é o que faz um
//	erro de configuração virar retry infinito ou um erro de infraestrutura virar
//	DLQ cheia:
//
//	  retryable (5xx, 429, rede, timeout)
//	    → `received` com `next_attempt_at` no futuro; no teto de tentativas,
//	      DLQ.
//	  401/403 (token)
//	    → DLQ AGORA. Repetir com o mesmo token nunca funciona, e quem precisa
//	      saber é o operador, não o backoff.
//	  422 (recusa de requisição: status fora do vocabulário, payload sem id)
//	    → DLQ AGORA. É um defeito do conteúdo do evento, e ele não muda com o
//	      tempo.
//	  404 (o Node não conhece esse id)
//	    → `ignored`, que é TERMINAL mas não é DLQ: a linha existe e fica
//	      visível, e `ignored` significa "chegou coisa que não era nossa" — que é
//	      o que 404 significa aqui.
func (d *Drainer) tratarErro(ctx context.Context, tx *sql.Tx, e eventRow, err error) {
	e2, classificado := nodeapi.AsError(err)

	switch {
	case classificado && e2.Status == 404:
		log.Printf("[queue] evento %s: o backend Node não conhece a linha %s — marcando ignorado (%v)",
			e.eventID, e.id, err)
		d.marcar(ctx, tx, e, "ignored", "", err.Error())
		return

	case classificado && (e2.Status == 401 || e2.Status == 403):
		// A mensagem cita a env pelo nome porque o log é o único lugar onde o
		// operador vai procurar quando a DLQ começa a encher, e "401" sozinho
		// não diz o que fazer.
		log.Printf("[queue] ERRO: o backend Node recusou o token interno (%v). Os eventos vão para a DLQ "+
			"até conferir PAGARME_INTERNAL_TOKEN nos dois serviços — token divergente é o sintoma deste 401, "+
			"e nada mais no log denuncia", err)
		d.marcar(ctx, tx, e, "failed", "", err.Error()) // DLQ: sem next_attempt_at
		return

	case classificado && e2.Status == 422:
		log.Printf("[queue] evento %s recusado pelo backend Node com 422 (payload inválido) — DLQ: repetir não muda o conteúdo (%v)",
			e.eventID, err)
		d.marcar(ctx, tx, e, "failed", "", err.Error()) // DLQ
		return

	case classificado && !e2.Retryable:
		log.Printf("[queue] evento %s: o backend Node recusou com %d — DLQ: repetir devolve a mesma recusa (%v)",
			e.eventID, e2.Status, err)
		d.marcar(ctx, tx, e, "failed", "", err.Error()) // DLQ
		return

	default:
		// Retryable (5xx, 429, rede, timeout) — e o erro sem classificação,
		// que só acontece se o `aplica` for um dublê que devolveu algo
		// estranho. Tratar como retryable é o lado seguro: reenfileirar custa
		// um ciclo, e o teto de tentativas existe.
		d.reagendar(ctx, tx, e, err.Error())
	}
}

// marcar grava o desfecho de um evento.
//
// `status` e `nextAttemptAt` são os dois eixos da máquina de estados da fila:
//
//	received  + next_attempt_at NULL   = elegível agora (evento novo)
//	failed    + next_attempt_at <agora> = aguardando o backoff
//	failed    + next_attempt_at NULL   = DLQ: fora da fila, à vista
//	processed / ignored                 = terminais
//
// A diferença entre `failed` com data e `failed` sem data é o que separa
// "aguardando o backoff" de "na DLQ", e é o segundo ramo da elegibilidade que
// mede (ver `reagendar` para por que o reenfileiramento grava `failed` e não
// `received`).
//
// `attempts` SOBE em toda falha, inclusive na que vai para a DLQ: é o contador
// que o `MaxAttempts` consulta, e é ele que impede um evento de ficar reentrando
// para sempre quando o teto não está sendo visto por ninguém.
func (d *Drainer) marcar(ctx context.Context, tx *sql.Tx, e eventRow, status, nextAttemptAt, errorMessage string) {
	_, err := tx.ExecContext(ctx,
		`UPDATE payment_event
		 SET status = $2, attempts = attempts + 1, error_message = $3, next_attempt_at = NULLIF($4, '')
		 WHERE id = $1`,
		e.id, status, inbox.TruncarError(errorMessage), nextAttemptAt)
	if err != nil {
		log.Printf("[queue] falha ao marcar o evento %s como %s: %v", e.eventID, status, err)
	}
}

// marcarTerminal é `marcar` sem backoff — para o caso em que a linha não pode
// mais ser processada e o operador precisa encontrá-la na inbox.
func (d *Drainer) marcarTerminal(ctx context.Context, tx *sql.Tx, e eventRow, status, errorMessage string) {
	log.Printf("[queue] evento %s: %s", e.eventID, errorMessage)
	d.marcar(ctx, tx, e, status, "", errorMessage)
}

// reagendar devolve o evento para a fila com backoff, ou manda para a DLQ se o
// teto estourou.
//
// A conta é a do Node com uma diferença EXPLÍCITA e deliberada:
//
//	attempts NO BANCO  ->  NOVO = attempts + 1
//	NOVO < MaxAttempts ->  failed + next_attempt_at = agora + Backoff(NOVO)
//	NOVO >= MaxAttempts ->  failed + next_attempt_at = NULL   (DLQ)
//
// ## Por que reenfileira em `failed` e não em `received`
//
// O `requeueFailedEventUsecase` do Node grava `status: 'received'` COM
// `next_attempt_at` preenchido (`payment.usecases.ts:711`), e a elegibilidade
// dele — que este serviço replica palavra por palavra, e tem que replicar, porque
// os dois workers leem a MESMA fila — é:
//
//	status = 'received' AND next_attempt_at IS NULL     -- evento novo
//	OU status = 'failed' AND next_attempt_at <= agora   -- backoff vencido
//	                                        (worker.ts:102)
//
// Uma linha `received` com `next_attempt_at` preenchido NÃO satisfaz nenhum dos
// dois ramos. Ou seja: o reenfileiramento do Node nunca é lido de volta, e a
// janela de retry do worker dele está morta na prática — a primeira falha tira o
// evento da fila para sempre, sem ser DLQ, sem `attempts` batendo o teto e sem
// nada no log que denuncie. (O conserto do Node é remover o `isNull` do predicado
// dele; fica para o PR de lá.)
//
// Reenfileirar em `failed` satisfaz o SEGUNDO ramo, e é o que faz o retry
// funcionar de verdade — nos dois sentidos, porque os dois workers leem linhas
// escritas pelo outro. O rótulo é a única divergência de estado, e ninguém decide
// o que fazer com um evento pelo rótulo `received`/`failed`: a elegibilidade é a
// mesma nos dois.
//
// `attempts` é contado pelos DOIS lados — este e o `processPaymentEventUsecase`
// do Node, que incrementa na sua própria transação — e por isso um evento pode
// gastar duas tentativas numa falha só. Isso encurta a DLQ em meio ciclo no
// máximo, e NUNCA a alonga: o que importa é que o teto existe e é o mesmo dos
// dois lados.
func (d *Drainer) reagendar(ctx context.Context, tx *sql.Tx, e eventRow, errorMessage string) {
	novas := e.attempts + 1
	if novas >= MaxAttempts {
		log.Printf("[queue] evento %s (tentativa %d/%d) foi para a DLQ: %s",
			e.eventID, novas, MaxAttempts, errorMessage)
		d.marcar(ctx, tx, e, "failed", "", errorMessage)
		return
	}

	espera := Backoff(novas)
	quando := inbox.NowISO(d.now().Add(espera))
	log.Printf("[queue] evento %s falhou (tentativa %d/%d), nova tentativa em %v: %s",
		e.eventID, novas, MaxAttempts, espera, errorMessage)
	d.marcar(ctx, tx, e, "failed", quando, errorMessage)
}

// cargaDe tira a `Charge` do payload bruto.
//
// O payload vem como o gateway mandou (bytes crus), então o parse é
// `json.Unmarshal` e a tradução é o MESMO `MapOrderToCharge` do webhook. Sem id
// é `ErrNoID` e o evento vai para a DLQ — é o mesmo desenho do
// `processPaymentEventUsecase`, que marca `failed` quando o `mapOrderToCharge`
// lança.
func cargaDe(rawPayload string) (*charge.Charge, error) {
	if strings.TrimSpace(rawPayload) == "" {
		return nil, errors.New("payload vazio")
	}
	var payload charge.WebhookPayload
	if err := json.Unmarshal([]byte(rawPayload), &payload); err != nil {
		return nil, err
	}
	return charge.MapOrderToCharge(payload.Data)
}
