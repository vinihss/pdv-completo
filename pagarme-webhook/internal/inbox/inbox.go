// Package inbox grava o evento do webhook em `payment_event` ANTES do HTTP 200.
//
// ## Por que a gravação vem antes da resposta
//
// O Pagar.me reenvia o mesmo evento enquanto não recebe 200 (a doc do gateway
// diz isso, e a spec §16 exige um efeito só). Persistir depois do ACK perde
// evento: o provedor já foi embora, ninguém mais manda e a cobrança fica
// pendente até a reconciliação — que é a rede de segurança, não o caminho
// principal. Por isso o handler grava e só então responde (paridade com
// `recordWebhookEventUsecase` em `application/payment/payment.usecases.ts:447`).
//
// ## Por que o dedupe é do BANCO e não do código
//
// `ON CONFLICT (provider, event_id) DO NOTHING` bate no índice único
// `uq_payment_event_provider_event_id`. Um `SELECT` seguido de `INSERT` seria a
// mesma lógica com uma janela de corrida no meio — e a janela existe de verdade,
// porque o Pagar.me pode mandar o mesmo evento duas vezes ao mesmo tempo, cada
// uma num processo HTTP diferente. O índice resolve os dois de uma vez, e o
// índice não depende de todo caminho de gravação lembrar de checar.
package inbox

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"time"

	"pdv-pagarme-webhook/internal/charge"
)

// Provider é o literal de `payment_event.provider`. O Node usa a mesma string em
// todo o resto do módulo (`PROVIDER` em payment.usecases.ts), e ela é parte do
// índice único junto com `event_id`: divergir aqui faria o mesmo evento gravar
// duas vezes, uma com `provider='pagarme'` e outra com `provider='Pagarme'`.
const Provider = "pagarme"

// insertStmt grava o evento.
//
// Colunas escolhidas uma a uma, e não `INSERT ... SELECT` genérico:
//
//   - `seq` NÃO entra: é BIGSERIAL e o banco gera. Mandar `seq` quebraria o
//     `ORDER BY seq` do drain, que é a ordem de chegada dos eventos.
//   - `payment_id` NÃO entra: é sempre NULL no insert. O Go nunca lê a tabela
//     `payment` para decidir nada, e deixar a coluna de fora do `INSERT` é o que
//     torna isso impossível de quebrar por engano — em vez de depender de todo
//     caminho saber passar `NULL`.
//   - `status` é literal `'received'`, e não um parâmetro: `received` é o único
//     estado de entrada da fila, e um parâmetro abriria a porta para gravar
//     `processed` sem ter processado.
//   - `attempts` e `next_attempt_at` não entram: default 0 e NULL, que é
//     exatamente "elegível agora".
const insertStmt = `INSERT INTO payment_event
	(id, provider, event_id, event_type, provider_order_id, provider_payment_id, payload, status, created_at)
	VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, 'received', $8)
	ON CONFLICT (provider, event_id) DO NOTHING
	RETURNING id`

// ErrNoEventID recusa um evento sem `id`.
//
// Recusar é melhor que aceitar um evento cego: sem `event_id` não há como
// deduplicar, e deduplicar é o requisito (spec §16). A resposta é 4xx, e não
// 200 — ver internal/server para por que isso é uma melhoria em relação ao Node,
// que responde 503 nesse caso e deixa o Pagar.me reenviar para sempre.
var ErrNoEventID = errors.New("evento sem id: não dá para deduplicar, e deduplicar é o requisito")

// EventTypeUnknown é o `event_type` gravado quando o payload não traz `type`.
// É o literal do Node (`payload.type ?? "unknown"`), e não um erro: o tipo é
// informativo, quem decide o que fazer com o evento é o `status` do ciclo.
const EventTypeUnknown = "unknown"

// maxErrorMessage é o teto de `error_message`. O Node corta em 500 no
// `processPaymentEventUsecase` e no `requeueFailedEventUsecase`, e o corte não é
// decorativo: a coluna é TEXT e um `error` de driver com o DSN inteiro (que
// contém a senha) passaria a ser lido por quem abre o painel.
const maxErrorMessage = 500

// TruncarError corta a mensagem no mesmo teto do Node.
func TruncarError(msg string) string {
	if len(msg) <= maxErrorMessage {
		return msg
	}
	return msg[:maxErrorMessage]
}

// Store grava eventos na inbox.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

// NewStore monta o Store. `now` injetado porque o formato de `created_at` é
// contrato (ver NowISO) e os testes precisam de um instante controlável para
// provar o formato string.
func NewStore(db *sql.DB, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, now: now}
}

// Record grava o evento e devolve o que o chamador precisa para responder.
//
// `rawBody` são os BYTES recebidos, e o que vai para `payload` é o corpo CRU
// como veio.
//
// ## Divergência consciente do Node, e por quê
//
// O Node grava `JSON.stringify(payload)` — o objeto já parseado, re-serializado.
// Aqui grava o corpo cru. As duas coisas reparseiam para o mesmo objeto (é o
// único consumidor: `JSON.parse(event.payload)` no `processPaymentEventUsecase`),
// mas o cru preserva o que o parse/re-stringify destrói: a ordem das chaves, a
// grafia do número (`1.50` → `1.5`, `1e2` → `100`) e o escape de `\u`. Guardar o
// que o gateway mandou é o que torna a linha Useful como PROVA — e a auditoria
// de pagamento é exatamente o caso em que se quer a prova, não uma normalização.
//
// `isNew` decide a resposta HTTP, e é o único jeito de o handler distinguir os
// dois casos: `false` = reenvio, que responde 200 sem fazer nada (4xx faria o
// Pagar.me reenviar indefinidamente um evento já tratado).
func (s *Store) Record(ctx context.Context, rawBody []byte, payload *charge.WebhookPayload) (rowID string, isNew bool, err error) {
	if payload == nil || payload.ID == "" {
		return "", false, ErrNoEventID
	}

	providerOrderID, providerPaymentID := payload.EventIDs()
	eventType := payload.Type
	if eventType == "" {
		eventType = EventTypeUnknown
	}

	rowID, err = NewUUID()
	if err != nil {
		return "", false, err
	}

	// `RETURNING id` + `DO NOTHING`: no conflito NENHUMA linha volta, e é
	// exatamente esse "nenhuma linha" que diz que o evento já existia. Assim o
	// dedupe e a descoberta do `id` da linha existente vêm do mesmo statement.
	var inserted string
	switch err := s.db.QueryRowContext(ctx, insertStmt,
		rowID, Provider, payload.ID, eventType, providerOrderID, providerPaymentID,
		string(rawBody), NowISO(s.now()),
	).Scan(&inserted); {
	case err == sql.ErrNoRows:
		// Conflito: o evento já foi gravado antes. Não é erro.
		return "", false, nil
	case err != nil:
		return "", false, err
	}
	return inserted, true, nil
}

// NowISO é o formato de `created_at`, e ele é CONTRATO, não estilo.
//
// `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'` é o `toISOString()` do JavaScript: milissegundo
// com 3 dígitos, sempre, UTC, com o `Z` literal. A coluna é TEXT e o drain
// ordena por `seq` (BIGSERIAL), mas o resto do sistema compara `created_at` como
// string — inclusive o `next_attempt_at <= agora` da elegibilidade e o
// `created_at` de `payment`, que o Go e o Node escrevem.
//
// `time.RFC3339` NÃO serve: ele trunca a fração para zero dígitos
// (`2026-10-04T12:00:00Z`), que ordena DEPOIS de `2026-10-04T12:00:00.500Z` no
// mesmo segundo e deixa de casar com o que o Node escreve na mesma coluna.
func NowISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// NewUUID devolve um UUID v4 (o `crypto.randomUUID()` do Node, que é o default
// de `id()` no schema).
//
// Implementado à mão em vez de puxar `github.com/google/uuid` porque são 20
// linhas e o binário inteiro tem UMA dependência (`lib/pq`) por decisão: o
// `go.mod` deste serviço é auditado no review, e cada dependência a menos é uma
// que não precisa de CVE nem de atualização.
func NewUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("não consegui gerar uuid: %w", err)
	}
	// Versão 4 (bits 12-15 = 0100) e variante RFC 4122 (bits 62-63 = 10).
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80

	var out [36]byte
	hex.Encode(out[0:8], b[0:4])
	out[8] = '-'
	hex.Encode(out[9:13], b[4:6])
	out[13] = '-'
	hex.Encode(out[14:18], b[6:8])
	out[18] = '-'
	hex.Encode(out[19:23], b[8:10])
	out[23] = '-'
	hex.Encode(out[24:36], b[10:16])
	return string(out[:]), nil
}

// LogEvento registra o desfecho da gravação. Existe para o operador ter uma
// linha com o par que importa — `event_id` do gateway e `isNew` — sem abrir a
// tabela. A mensagem diferencia os dois casos em palavras, não em código: quem lê
// o log durante um reenvio em massa precisa ver "repetido" e não `isNew=false`
// para entender que nada está quebrado.
func LogEvento(eventID, eventType, rowID string, isNew bool) {
	if isNew {
		log.Printf("[inbox] evento do pagarme gravado: event_id=%s type=%s row=%s", eventID, eventType, rowID)
		return
	}
	log.Printf("[inbox] evento do pagarme repetido — ignorado (já estava na inbox): event_id=%s type=%s", eventID, eventType)
}
