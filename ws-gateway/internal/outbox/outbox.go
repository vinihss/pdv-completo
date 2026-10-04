// Package outbox implementa o dispatcher que transforma linhas de
// `outbox_event` em frames de WebSocket.
//
// Por que outbox e não notificação direta: a intenção de emitir é gravada na
// MESMA transação que grava o dado (ver enqueueEvent em order.usecases.ts e
// companhia). Se o processo morresse entre o commit e o broadcast, o evento
// existia mas ninguém soube — o client ficaria com a tela desatualizada até
// o próximo reload, sem nenhum sinal de que houve evento perdido. Com outbox, a
// linha sobrevive e o dispatcher pega na volta.
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"
)

const (
	// PollMS e BatchSize espelham outbox-dispatcher.ts (POLL_MS=200,
	// BATCH_SIZE=50). Mesmos números de propósito: mudar aqui e não lá muda a
	// latência do bell e a pressão no banco, e durante a migração as duas
	// implementções do dispatcher disputam o mesmo lock do mesmo lote.
	PollMS     = 200
	BatchSize  = 50
	lockName   = "pdv:outbox:owner" // ver LOCKS.outboxDispatcher em infra/locks.ts
	selectStmt = `SELECT id, event_type, room, payload
			FROM outbox_event
			WHERE published = false
			ORDER BY created_at ASC, seq ASC
			LIMIT $1`
)

// RoomBroadcaster é o que o dispatcher precisa do hub. Interface mínima para
// poder testar o dispatcher sem subir websocket nem banco.
type RoomBroadcaster interface {
	BroadcastToRoom(room string, payload []byte) int
}

// Dispatcher varre o outbox e publica.
type Dispatcher struct {
	db    *sql.DB
	hub   RoomBroadcaster
	poll  time.Duration
	batch int
}

// New monta um Dispatcher.
func New(db *sql.DB, hub RoomBroadcaster) *Dispatcher {
	return &Dispatcher{db: db, hub: hub, poll: PollMS * time.Millisecond, batch: BatchSize}
}

// Run faz o polling até o ctx ser cancelado.
//
// Nenhum erro de ciclo derruba o processo: o `logger` do Node faz o mesmo
// (outbox-dispatcher.ts, POLL_MS). Um banco oscilando por 5 segundos não pode
// levar o realtime junto — o cliente seguiria vendo o gateway vivo e sem
// evento, que é o pior estado possível (silencioso).
func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(d.poll)
	defer ticker.Stop()

	// Um ciclo no boot, antes do primeiro tick: sem isso, o primeiro evento leva
	// 200ms de atraso mesmo com a fila parada, e logo na entrada parece que o
	// bell não funciona.
	if _, err := d.PollOnce(ctx); err != nil && ctx.Err() == nil {
		log.Printf("[outbox] erro no primeiro ciclo: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			log.Println("[outbox] dispatcher parado")
			return
		case <-ticker.C:
			if _, err := d.PollOnce(ctx); err != nil && ctx.Err() == nil {
				log.Printf("[outbox] erro no ciclo de polling: %v", err)
			}
		}
	}
}

// PollOnce é um ciclo de publicação. Retorna quantos eventos foram lidos.
//
// O ciclo inteiro roda dentro do advisory lock de TRANSAÇÃO (`pdv:outbox:owner`):
// se outro processo — uma instância do Node, ou uma segunda réplica do gateway —
// já está publicando, este ciclo pula em silêncio em vez de disputar os mesmos 50
// eventos a cada 200ms. Como o backend tem o MESMO dispatcher ligado durante a
// migração, os dois disputam o mesmo lock e só um publica por vez.
//
// `pg_try_advisory_xact_lock` e NUNCA `pg_try_advisory_lock`: o lock de sessão
// ficaria preso na conexão ociosa do pool (database/sql não faz pin de conexão),
// as queries seguintes cairiam em outras conexões e não enxergariam o lock. O
// lock de transação é liberado no COMMIT/ROLLBACK, que é a garantia que o
// código precisa. Ver a nota em backend/src/infra/locks.ts.
//
// Efeito colateral desejável de o lote estar na transação: o SELECT dos 50
// pendentes e os 50 `UPDATE published = true` viram atômicos. Se o processo
// cair no meio do loop, ou commita o lote inteiro, ou os 50 voltam a ficar
// pendentes e são redeliveridos no poll seguinte. (O broadcast em si fica fora
// do rollback: cair depois do broadcast e antes do COMMIT reemite o evento —
// entrega duplicada é o custo aceito de um outbox, e o client recarrega por REST
// de qualquer forma.)
func (d *Dispatcher) PollOnce(ctx context.Context) (int, error) {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() // no-op se já commitou

	var locked bool
	err = tx.QueryRowContext(ctx,
		`SELECT pg_try_advisory_xact_lock(hashtext($1))`, lockName).Scan(&locked)
	if err != nil {
		return 0, err
	}
	if !locked {
		// Réplica não-eleita não é erro: é o desenho. A tentativa é de graça
		// (`try_`), então custa uma query a cada 200ms.
		return 0, nil
	}

	type pending struct {
		id      string
		typ     string
		room    string
		payload string
	}

	rows, err := tx.QueryContext(ctx, selectStmt, d.batch)
	if err != nil {
		return 0, err
	}

	var batch []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.typ, &p.room, &p.payload); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	for _, evt := range batch {
		d.publish(ctx, tx, evt.id, evt.typ, evt.room, evt.payload)
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(batch), nil
}

// publish emite um evento e marca como publicado.
//
// Os dois caminhos marcam publicado, inclusive o de payload corrompido: a partir
// daquele payload o broadcast é irrecuperável, e deixar pendente criaria um loop
// apertado de retry a cada 200ms sobre uma linha que nunca vai ser lida
// (o Node faz o mesmo em pollOutboxOnce).
func (d *Dispatcher) publish(ctx context.Context, tx *sql.Tx, id, typ, room, rawPayload string) {
	markPublished := func() {
		if _, err := tx.ExecContext(ctx,
			`UPDATE outbox_event SET published = true WHERE id = $1`, id); err != nil {
			log.Printf("[outbox] falha ao marcar %s publicado: %v", id, err)
		}
	}

	var payload json.RawMessage
	if err := json.Unmarshal([]byte(rawPayload), &payload); err != nil {
		log.Printf("[outbox] descartando evento %s (%s) com payload corrompido: %v", id, typ, err)
		markPublished()
		return
	}

	frame, err := Envelope(typ, payload)
	if err != nil {
		log.Printf("[outbox] falha ao montar envelope de %s (%s): %v", id, typ, err)
		markPublished()
		return
	}

	// Retorno ignorado de propósito: zero assinantes não é erro. O dispatcher
	// marca publicado assim mesmo (o Node também) — o client que precisa do
	// evento recarrega por REST, e não existe redelivery.
	d.hub.BroadcastToRoom(room, frame)
	markPublished()
}

// Envelope monta o JSON que o client recebe. Espelha
// `JSON.stringify({ ...event, emittedAt })` de ws-gateway.ts.
//
// `emittedAt` é o instante em que o BROADCAST saiu, não o do commit da escrita —
// é o que o client usa para descartar evento fora de ordem.
func Envelope(eventType string, payload json.RawMessage) ([]byte, error) {
	if len(payload) == 0 {
		payload = json.RawMessage("null")
	}
	return json.Marshal(struct {
		Type      string          `json:"type"`
		Payload   json.RawMessage `json:"payload"`
		EmittedAt string          `json:"emittedAt"`
	}{
		Type:      eventType,
		Payload:   payload,
		EmittedAt: NowISO(),
	})
}

// NowISO é o mesmo formato do `new Date().toISOString()` do Node — milissegundo
// com 3 dígitos, sempre. Não usar time.RFC3339: ele trunca a fração para 0
// dígitos, e o formatador de data do client (ou um `sort` por string) passa a
// ver timestamps diferentes dos do Node para o mesmo instante.
func NowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}
