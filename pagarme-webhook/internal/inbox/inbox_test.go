package inbox

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pdv-pagarme-webhook/internal/charge"
	"pdv-pagarme-webhook/internal/db"
)

// dbConnect delega para `internal/db`, que é o mesmo caminho do binário (mesmo
// driver, mesmo ping, mesmos limites de pool) — e evita declarar dependência de
// lib/pq que só existe para isto.
func dbConnect(dsn string) (*sql.DB, error) { return db.Connect(dsn) }

// =============================================================================
// Suíte da inbox.
//
// O `Record` grava em `payment_event` DE VERDADE: o que está em jogo é o
// `ON CONFLICT` do índice único `uq_payment_event_provider_event_id`, e um mock
// de banco não provaria nada sobre ele — um mock que devolve "conflito" quando
// o teste quer provaria exatamente o que o teste mandou.
//
// Os testes pulam sem `PAGARME_TEST_DATABASE_URL` (nunca falham por falta de
// banco). Localmente:
//
//	PAGARME_TEST_DATABASE_URL='postgres://pdv:pdv@localhost:5432/pdv_test?sslmode=disable' \
//	  go test -race -count=1 ./internal/inbox/
//
// O `?sslmode=disable` é obrigatório, não decoração: o driver é o `lib/pq`
// (`internal/db`), que assume `sslmode=require` quando a DSN não diz nada, e um
// Postgres de dev comum não tem SSL — sem o parâmetro os testes pulam com
// "pq: SSL is not enabled on the server", ou seja, env setada, suíte verde e
// nada exercitado.
//
// O banco tem que ser DEDICADO: os testes gravam linhas de verdade e disputam o
// advisory lock `pdv:payment:worker` nos testes do drain (internal/queue).
// =============================================================================

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// testDB abre um pool isolado num schema único desta execução.
//
// ## Por que um schema
//
// O dedupe é `ON CONFLICT (provider, event_id)` sobre um índice UNIQUE, e o índice
// é a única coisa que a suíte precisa provar de verdade — um mock devolveria
// "conflito" quando o teste mandasse, provando exatamente o que o teste mandou.
//
// A isolamento precisa ir além de nomes de linha únicos: o `event_id` é único por
// construção, mas a PK `id` é gerada, e um banco compartilhado com execuções
// anteriores (ou com a suíte do `internal/queue`, que usa as MESMAS tabelas)
// acumula linhas. Um schema novo por execução resolve os dois: nenhuma linha de
// fora é visível e nada é apagado.
func testDB(t *testing.T) *sql.DB {
	t.Helper()

	dsn := os.Getenv("PAGARME_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PAGARME_TEST_DATABASE_URL não definida: suíte da inbox (precisa de Postgres) pulada")
	}

	schema := "pagarme_inbox_test_" + schemaSufixo(t)

	// Uma conexão admin (search_path padrão) só para criar e remover o schema.
	// `t.Cleanup` roda em LIFO, então o fechamento vai PRIMEIRO na lista e é a
	// ÚLTIMA coisa a rodar — o `DROP` tem que acontecer com a conexão de pé.
	admin, err := dbConnect(dsn)
	if err != nil {
		t.Skipf("Postgres de teste não respondeu (%v): suíte da inbox pulada", err)
	}
	t.Cleanup(func() { _ = admin.Close() })

	if _, err := admin.Exec(`CREATE SCHEMA IF NOT EXISTS ` + pqQuoteIdent(schema)); err != nil {
		t.Fatalf("não consegui criar o schema de teste %s: %v", schema, err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(`DROP SCHEMA IF EXISTS ` + pqQuoteIdent(schema) + ` CASCADE`); err != nil {
			t.Logf("não consegui remover o schema de teste %s: %v", schema, err)
		}
	})

	// `options=-c search_path=...` no DSN, e não um `SET search_path` por conexão:
	// o `database/sql` abre e fecha conexões o tempo todo, e um `search_path` de
	// sessão morre com a sessão. O `options` é aplicado pelo servidor em CADA
	// conexão nova, que é o que o pool precisa.
	conn, err := dbConnect(dsn + "&options=" + url.QueryEscape("-c search_path="+schema))
	if err != nil {
		t.Fatalf("não consegui abrir o pool no schema %s: %v", schema, err)
	}
	t.Cleanup(func() { conn.Close() })

	if _, err := conn.Exec(criarPaymentEvent); err != nil {
		t.Fatalf("não consegui garantir a tabela payment_event no banco de teste: %v", err)
	}
	return conn
}

// pqQuoteIdent protege o nome do schema. O nome é gerado por este arquivo (só
// hex, underscore e dígitos) e nunca é entrada de usuário, mas um identificador
// interpolado sem aspas é o tipo de coisa que alguém estende um dia sem perceber.
func pqQuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// schemaSufixo devolve um sufixo aleatório e único dentro do processo.
func schemaSufixo(t *testing.T) string {
	t.Helper()
	var s [6]byte
	if _, err := rand.Read(s[:]); err != nil {
		t.Fatalf("rand falhou: %v", err)
	}
	return fmt.Sprintf("%s_%d", hex.EncodeToString(s[:]), atomic.AddInt32(&contadorSchema, 1))
}

var contadorSchema int32

// criarPaymentEvent é a tabela que o webhook grava, com os mesmos nomes de
// coluna do backend (backend/migrations/0002_pagarme.sql:121). `IF NOT EXISTS`
// de propósito: quem apontar a env para um banco que já tem a tabela real do
// migrate usa a real.
//
// O `payment_event` real tem `payment_id` com FK para `payment`; aqui a coluna
// existe e NÃO tem FK, porque a suíte não cria a tabela `payment` e o que está em
// jogo no insert é a ausência da coluna na lista de inserção — que é o que
// garante `payment_id = NULL`.
const criarPaymentEvent = `CREATE TABLE IF NOT EXISTS payment_event (
	id text PRIMARY KEY,
	seq bigserial NOT NULL,
	provider text NOT NULL,
	event_id text NOT NULL,
	event_type text NOT NULL,
	payment_id text,
	provider_order_id text,
	provider_payment_id text,
	payload text NOT NULL,
	status text NOT NULL DEFAULT 'received',
	attempts integer NOT NULL DEFAULT 0,
	processed_at text,
	error_message text,
	next_attempt_at text,
	created_at text NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)`

// uniqueIndexPaymentEvent recria o índice único que faz o dedupe. É
// separado do CREATE TABLE porque o `ON CONFLICT (provider, event_id)` do
// `Record` NÃO funciona sem ele — e sem o índice a suíte mediria o
// comportamento errado (o ON CONFLICT viraria erro), o que é pelo menos um
// sinal claro.
func uniqueIndexPaymentEvent(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_event_provider_event_id
		ON payment_event(provider, event_id)`); err != nil {
		t.Fatalf("não consegui criar o índice de dedupe: %v", err)
	}
}

// eventIDUnique devolve um `event_id` que nenhuma outra linha usa.
func eventIDUnique(t *testing.T) string {
	t.Helper()
	var s [8]byte
	if _, err := rand.Read(s[:]); err != nil {
		t.Fatalf("rand falhou: %v", err)
	}
	return "evt_test_" + hex.EncodeToString(s[:])
}

// linhaLida é o que a suíte precisa observar da linha gravada.
type linhaLida struct {
	id                string
	seq               int64
	provider          string
	eventID           string
	eventType         string
	paymentID         sql.NullString
	providerOrderID   sql.NullString
	providerPaymentID sql.NullString
	payload           string
	status            string
	attempts          int
	nextAttemptAt     sql.NullString
	createdAt         string
}

func lerLinha(t *testing.T, db *sql.DB, eventID string) linhaLida {
	t.Helper()
	var l linhaLida
	err := db.QueryRow(`SELECT id, seq, provider, event_id, event_type, payment_id,
			provider_order_id, provider_payment_id, payload, status, attempts, next_attempt_at, created_at
		FROM payment_event WHERE provider = $1 AND event_id = $2`, Provider, eventID).
		Scan(&l.id, &l.seq, &l.provider, &l.eventID, &l.eventType, &l.paymentID,
			&l.providerOrderID, &l.providerPaymentID, &l.payload, &l.status, &l.attempts,
			&l.nextAttemptAt, &l.createdAt)
	if err != nil {
		t.Fatalf("não consegui ler a linha do evento %s: %v", eventID, err)
	}
	return l
}

func contaLinhas(t *testing.T, db *sql.DB, eventID string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM payment_event WHERE provider = $1 AND event_id = $2`, Provider, eventID).Scan(&n); err != nil {
		t.Fatalf("count falhou: %v", err)
	}
	return n
}

// payloadDe devolve o struct parseado do corpo do evento, que é o que o
// handler entrega ao `Record`.
func payloadDe(t *testing.T, eventID string) *charge.WebhookPayload {
	t.Helper()
	var p charge.WebhookPayload
	if err := json.Unmarshal([]byte(payloadJSON(eventID)), &p); err != nil {
		t.Fatalf("payload de teste não parseou: %v", err)
	}
	return &p
}

func payloadJSON(eventID string) string {
	return `{"id":"` + eventID + `","type":"order.paid","data":{"id":"or_1","payments":[{"id":"pay_1","status":"paid"}]}}`
}

// -----------------------------------------------------------------------------
// o caminho feliz
// -----------------------------------------------------------------------------

func TestRecordGravaEventoNovo(t *testing.T) {
	db := testDB(t)
	uniqueIndexPaymentEvent(t, db)

	eventID := eventIDUnique(t)
	body := payloadJSON(eventID)
	store := NewStore(db, nil)

	rowID, isNew, err := store.Record(context.Background(), []byte(body), payloadDe(t, eventID))
	if err != nil {
		t.Fatalf("Record falhou: %v", err)
	}
	if !isNew {
		t.Fatal("evento novo veio com isNew=false")
	}

	l := lerLinha(t, db, eventID)
	if l.id != rowID {
		t.Errorf("id devolvido %q != id na linha %q", rowID, l.id)
	}
	if l.provider != Provider {
		t.Errorf("provider = %q, quer %q", l.provider, Provider)
	}
	if l.eventType != "order.paid" {
		t.Errorf("eventType = %q, quer order.paid", l.eventType)
	}
	if l.status != "received" {
		t.Errorf("status = %q, quer received", l.status)
	}
	if l.attempts != 0 {
		t.Errorf("attempts = %d, quer 0", l.attempts)
	}
	// `next_attempt_at` NULL é o que torna a linha elegível pelo drain.
	if l.nextAttemptAt.Valid {
		t.Errorf("nextAttemptAt = %q, quer NULL (elegível agora)", l.nextAttemptAt.String)
	}
	if l.payload != body {
		t.Errorf("payload gravado difere do corpo recebido:\n gravado=%s\n recebido=%s", l.payload, body)
	}
	if l.providerOrderID.String != "or_1" {
		t.Errorf("providerOrderId = %q, quer or_1", l.providerOrderID.String)
	}
	if l.providerPaymentID.String != "pay_1" {
		t.Errorf("providerPaymentId = %q, quer pay_1", l.providerPaymentID.String)
	}
	if l.seq == 0 {
		t.Error("seq = 0: o banco tem que gerar o BIGSERIAL (é ele que ordena o drain)")
	}
}

// -----------------------------------------------------------------------------
// dedupe: o índice único, e nunca 4xx no reenvio
// -----------------------------------------------------------------------------

// O reenvio é o caso que a doc do provedor promete que vai acontecer ("reenvia
// enquanto não recebe 200"), e a resposta tem que ser 200 COM `isNew=false` — o
// handler transforma isso em 200 (ver internal/server). O que este teste fixa é
// o `isNew`, porque é ele que o handler traduz em resposta.
func TestRecordDedupeNoReenvio(t *testing.T) {
	db := testDB(t)
	uniqueIndexPaymentEvent(t, db)

	eventID := eventIDUnique(t)
	body := payloadJSON(eventID)
	store := NewStore(db, nil)
	payload := payloadDe(t, eventID)

	primeiroID, isNew, err := store.Record(context.Background(), []byte(body), payload)
	if err != nil || !isNew {
		t.Fatalf("primeira gravação: isNew=%v err=%v", isNew, err)
	}

	// Três reenvios, como o Pagar.me faria enquanto não recebe 200.
	for i := 0; i < 3; i++ {
		rowID, isNew, err := store.Record(context.Background(), []byte(body), payload)
		if err != nil {
			t.Fatalf("reenvio %d deu erro: %v (o dedupe não pode ser erro)", i+1, err)
		}
		if isNew {
			t.Fatalf("reenvio %d veio com isNew=true", i+1)
		}
		if rowID != "" {
			t.Errorf("reenvio %d devolveu id %q: no conflito nenhuma linha volta", i+1, rowID)
		}
	}

	// O que prova que foi o BANCO que deduplicou e não o código: existe
	// exatamente UMA linha, e com o id do primeiro insert. Um `SELECT` antes do
	// `INSERT` daria o mesmo resultado neste teste — e o mesmo resultado errado
	// quando dois requests chegarem juntos.
	if n := contaLinhas(t, db, eventID); n != 1 {
		t.Fatalf("há %d linhas para o mesmo (provider, event_id); o índice único tem que impedir a segunda", n)
	}
	l := lerLinha(t, db, eventID)
	if l.id != primeiroID {
		t.Errorf("a linha sobrevivente tem id %q, quer o do primeiro insert %q", l.id, primeiroID)
	}
	if l.payload != body {
		t.Errorf("o reenvio sobrescreveu o payload: %s", l.payload)
	}
}

// A dedupe é por PAR (provider, event_id). Dois `event_id` iguais de providers
// diferentes são linhas diferentes — é o que permite que um dia exista outro
// provedor sem colisão. `provider` é literal aqui, então o teste grava a linha
// "de outro provider" na mão para provar que o índice é composto e não único
// só por `event_id`.
func TestRecordDedupeEPorParDeProvider(t *testing.T) {
	db := testDB(t)
	uniqueIndexPaymentEvent(t, db)

	eventID := eventIDUnique(t)

	// Gravação normal: provider = 'pagarme'.
	if _, isNew, err := NewStore(db, nil).Record(context.Background(), []byte(payloadJSON(eventID)), payloadDe(t, eventID)); err != nil || !isNew {
		t.Fatalf("gravação: isNew=%v err=%v", isNew, err)
	}

	// Mesma linha com outro provider: o índice composto NÃO pode colidir.
	if _, err := db.Exec(`INSERT INTO payment_event (id, provider, event_id, event_type, payload, created_at)
		VALUES ('outro-provider', 'ifood', $1, 'order.paid', '{}', '2026-01-01T00:00:00.000Z')`, eventID); err != nil {
		t.Fatalf("o índice está colidindo entre providers diferentes: %v", err)
	}

	// E o mesmo provider com OUTRO event_id também é linha nova.
	if _, isNew, err := NewStore(db, nil).Record(context.Background(), []byte(payloadJSON(eventID+"_b")), payloadDe(t, eventID+"_b")); err != nil || !isNew {
		t.Fatalf("event_id diferente colidiu: isNew=%v err=%v", isNew, err)
	}
}

// -----------------------------------------------------------------------------
// evento sem id
// -----------------------------------------------------------------------------

// Sem `event_id` não há como deduplicar, e deduplicar é o requisito. O `Record`
// recusa com `ErrNoEventID` e o handler traduz em 4xx (paridade de intenção com
// o Node, que também recusa — mas responde 503; ver a nota de divergência em
// GO-PAGARME-PLAN.md §"Divergências conscientes").
func TestRecordRecusaEventoSemID(t *testing.T) {
	db := testDB(t)
	uniqueIndexPaymentEvent(t, db)

	store := NewStore(db, nil)

	for _, p := range []*charge.WebhookPayload{
		nil,                 // payload nem chegou a ser parseado
		{ID: ""},            // `{"id":""}` — explicitamente vazio
		{ID: "", Type: "x"}, // id vazio com o resto presente
	} {
		rowID, isNew, err := store.Record(context.Background(), []byte(`{}`), p)
		if err == nil {
			t.Fatalf("payload %+v foi aceito (isNew=%v, id=%q): evento cego na inbox", p, isNew, rowID)
		}
		if err != ErrNoEventID {
			t.Fatalf("erro %v, quer ErrNoEventID", err)
		}
		if isNew {
			t.Error("isNew=true com erro: o handler não pode traduzir isso em 200")
		}
	}
}

// -----------------------------------------------------------------------------
// payment_id é sempre NULL
// -----------------------------------------------------------------------------

// O Go nunca lê a tabela `payment` para decidir nada, então nunca tem `payment_id`
// para preencher: a linha nasce órfã de propósito e quem aponta o evento para a
// cobrança é o `processPaymentEventUsecase` do Node, depois que ele casou o
// evento por `provider_payment_id`/`provider_order_id`. O caminho do Go é: o
// evento existe (ele grava), e quem casa é o Node (ele roda a transação).
func TestRecordDeixaPaymentIDNulo(t *testing.T) {
	db := testDB(t)
	uniqueIndexPaymentEvent(t, db)

	eventID := eventIDUnique(t)
	if _, _, err := NewStore(db, nil).Record(context.Background(), []byte(payloadJSON(eventID)), payloadDe(t, eventID)); err != nil {
		t.Fatalf("Record falhou: %v", err)
	}

	l := lerLinha(t, db, eventID)
	if l.paymentID.Valid {
		t.Errorf("payment_id = %q, quer NULL: o Go nuncaresolve a cobrança local", l.paymentID.String)
	}
}

// -----------------------------------------------------------------------------
// created_at: o formato é o teste mais fácil de quebrar e o pior de errar
// -----------------------------------------------------------------------------

// `created_at` é TEXT e precisa ser byte-a-byte o que o Node grava
// (`new Date().toISOString()`), porque o mesmo arquivo `0002_pagarme.sql` tem o
// mesmo default (`to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)
// e porque `next_attempt_at <= agora` compara TEXTO. `time.RFC3339` trunca a
// fração para 0 dígitos e passaria em quase todo teste que só checa "tem data".
var isoMilliseconds = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

func TestNowISOFormatoExato(t *testing.T) {
	casos := []struct {
		nome    string
		entrada time.Time
	}{
		{"meio dia UTC", time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)},
		{"com milissegundo", time.Date(2026, 1, 2, 3, 4, 5, 123_456_789, time.UTC)},
		{"com nanos que NAO podem aparecer", time.Date(2026, 12, 31, 23, 59, 59, 999_999_999, time.UTC)},
		// O `.000` tem que aparecer mesmo com zero de nanos: é o que separa
		// `2026-01-01T00:00:00.000Z` de `2026-01-01T00:00:00Z`, e a comparação
		// de string do `next_attempt_at` depende dos dois terem 24 caracteres.
		{"zero de milissegundo", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			got := NowISO(c.entrada)
			if !isoMilliseconds.MatchString(got) {
				t.Fatalf("NowISO = %q, que não casa com yyyy-mm-ddTHH:MM:SS.mmmZ", got)
			}
			if len(got) != 24 {
				t.Errorf("NowISO = %q tem %d caracteres, quer 24", got, len(got))
			}
		})
	}
}

// Fuso: `NowISO` converte para UTC. Sem isso, um processo com `TZ=America/Sao_Paulo`
// gravaria `2026-10-04T09:00:00.000-03:00` (26+ caracteres, com offset) na mesma
// coluna que o Node grava em UTC — e as duas linhas deixariam de se comparar
// como string.
func TestNowISOConverteParaUTC(t *testing.T) {
	saoPaulo := time.FixedZone("BRT", -3*3600)
	instante := time.Date(2026, 10, 4, 9, 0, 0, 500_000_000, saoPaulo)

	got := NowISO(instante)
	if got != "2026-10-04T12:00:00.500Z" {
		t.Errorf("NowISO = %q, quer 2026-10-04T12:00:00.500Z (09:00 em São Paulo é 12:00 UTC)", got)
	}
}

// O teste de regressão mais fácil de quebrar: o layout. Um `.000` que vira `.0`
// ou um `Z` que vire `+00:00` não quebra nenhum teste de comportamento — só a
// comparação de string entre instâncias e o `ORDER BY` dentro do mesmo segundo.
func TestNowISOLayoutNaoSeDesloca(t *testing.T) {
	casos := []struct {
		instante time.Time
		quer     string
	}{
		{time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC), "2026-10-04T12:00:00.000Z"},
		{time.Date(2026, 10, 4, 12, 0, 0, 1_000_000, time.UTC), "2026-10-04T12:00:00.001Z"},
		{time.Date(2026, 10, 4, 12, 0, 0, 999_000_000, time.UTC), "2026-10-04T12:00:00.999Z"},
		{time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), "2026-01-01T00:00:00.000Z"},
		{time.Date(2026, 12, 31, 23, 59, 59, 0, time.UTC), "2026-12-31T23:59:59.000Z"},
	}

	for _, c := range casos {
		if got := NowISO(c.instante); got != c.quer {
			t.Errorf("NowISO(%v) = %q, quer %q", c.instante, got, c.quer)
		}
	}
}

// E o mesmo formato tem que chegar ao BANCO, não só a string: o teste da gravação
// confere o valor persistido.
func TestRecordGravaCreatedAtNoFormatoDoBanco(t *testing.T) {
	db := testDB(t)
	uniqueIndexPaymentEvent(t, db)

	instante := time.Date(2026, 10, 4, 12, 34, 56, 789_000_000, time.UTC)
	eventID := eventIDUnique(t)

	store := NewStore(db, func() time.Time { return instante })
	if _, _, err := store.Record(context.Background(), []byte(payloadJSON(eventID)), payloadDe(t, eventID)); err != nil {
		t.Fatalf("Record falhou: %v", err)
	}

	l := lerLinha(t, db, eventID)
	if l.createdAt != "2026-10-04T12:34:56.789Z" {
		t.Errorf("created_at gravado = %q, quer 2026-10-04T12:34:56.789Z", l.createdAt)
	}
}

// -----------------------------------------------------------------------------
// event_type ausente
// -----------------------------------------------------------------------------

// `type` ausente vira o literal `"unknown"` e não erro: o tipo é informativo, e o
// que decide o que acontece com o evento é o `status` do ciclo. Recusar aqui
// perderia um evento de verdade por causa de um campo decorativo.
func TestRecordGravaUnknownQuandoTypeAusente(t *testing.T) {
	db := testDB(t)
	uniqueIndexPaymentEvent(t, db)

	eventID := eventIDUnique(t)
	body := `{"id":"` + eventID + `","data":{"id":"or_1"}}`
	p := *payloadDe(t, eventID)
	p.Type = ""

	if _, _, err := NewStore(db, nil).Record(context.Background(), []byte(body), &p); err != nil {
		t.Fatalf("Record falhou: %v", err)
	}

	l := lerLinha(t, db, eventID)
	if l.eventType != EventTypeUnknown {
		t.Errorf("eventType = %q, quer %q", l.eventType, EventTypeUnknown)
	}
}

// -----------------------------------------------------------------------------
// NewUUID
// -----------------------------------------------------------------------------

// O `id` da linha é UUID v4, o mesmo que `crypto.randomUUID()` gera no Node
// (default de `id()` no schema, schema.ts:71). Se o formato mudasse, o id
// gravado passaria a não casar com o que qualquer consumidores espera de um UUID.
func TestNewUUIDFormatoV4(t *testing.T) {
	v4 := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

	for i := 0; i < 50; i++ {
		id, err := NewUUID()
		if err != nil {
			t.Fatalf("NewUUID falhou: %v", err)
		}
		if !v4.MatchString(id) {
			t.Fatalf("uuid %q não é v4 canônico", id)
		}
		if len(id) != 36 {
			t.Fatalf("uuid %q tem %d caracteres, quer 36", id, len(id))
		}
	}
}

// Dois ids nunca colidem: o `id` é a chave primária, e uma colisão seria um evento
// perdido — e o `ON CONFLICT` do dedupe é em `(provider, event_id)`, então a
// colisão do `id` estouraria como erro de PK, não como reenvio.
func TestNewUUIDNaoRepete(t *testing.T) {
	vistos := map[string]bool{}
	for i := 0; i < 2000; i++ {
		id, err := NewUUID()
		if err != nil {
			t.Fatalf("NewUUID falhou: %v", err)
		}
		if vistos[id] {
			t.Fatalf("uuid repetido na 500ª sorte: %q", id)
		}
		vistos[id] = true
	}
}

// -----------------------------------------------------------------------------
// TruncarError
// -----------------------------------------------------------------------------

// O `error_message` é cortado em 500 pelo Node, e o corte não é decoração: um
// erro de driver do Postgres traz o DSN inteiro, que tem a senha.
func TestTruncarError(t *testing.T) {
	longa := ""
	for i := 0; i < 200; i++ {
		longa += "abcdefgh"
	}
	if got := TruncarError(longa); len(got) != maxErrorMessage {
		t.Errorf("TruncarError cortou em %d, quer %d", len(got), maxErrorMessage)
	}
	if got := TruncarError("curta"); got != "curta" {
		t.Errorf("TruncarError mexeu numa mensagem curta: %q", got)
	}
	if got := TruncarError(""); got != "" {
		t.Errorf("TruncarError(\"\") = %q", got)
	}
}
