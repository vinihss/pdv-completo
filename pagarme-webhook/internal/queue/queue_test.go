package queue

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pdv-pagarme-webhook/internal/charge"
	"pdv-pagarme-webhook/internal/db"
	"pdv-pagarme-webhook/internal/gateway"
	"pdv-pagarme-webhook/internal/nodeapi"
)

// =============================================================================
// Suíte do drain e da reconciliação.
//
// Três camadas, e nem tudo aqui precisa de banco:
//
// 1. PURE (backoff, gate, textArray, cargaDe) — sem env, sem rede.
// 2. GATE com banco INALCANÇÁVEL — o par de testes que prova que `Run` com o
//    drain ligado NÃO volta (entra no laço) e com desligado volta na hora.
// 3. CICLO (`DrainOnce`) — precisa de Postgres de verdade, porque o que está em
//    jogo é a coluna `status`/`attempts`/`next_attempt_at` e o advisory lock, e um
//    mock não prova nada sobre nenhum dos três. Pulam sem
//    `PAGARME_TEST_DATABASE_URL`; localmente:
//
//	PAGARME_TEST_DATABASE_URL='postgres://pdv:pdv@localhost:5432/pdv_test?sslmode=disable' \
//	  go test -race -count=1 ./internal/queue/
//
// O `?sslmode=disable` é obrigatório, não decoração: o driver é o `lib/pq`, que
// assume `sslmode=require` quando a DSN não diz nada — sem o parâmetro os testes
// pulam com "pq: SSL is not enabled on the server", ou seja, env setada, suíte
// verde e nada exercitado.
//
// O banco tem que ser DEDICADO: o `DrainOnce` disputa o advisory lock
// `pdv:payment:worker`, o mesmo do backend (e o mesmo que o `ws-gateway` usa em
// outro lock, mas o `payment` é outro). Com o worker do Node rodando no mesmo
// banco, os ciclos se alternam e a linha plantada some.
// =============================================================================

// -----------------------------------------------------------------------------
// doubles
// -----------------------------------------------------------------------------

// fakeAplica é o endpoint interno do Node em miniatura.
//
// Guarda o que recebeu (para o teste conferir o contrato) e devolve o que o teste
// mandar. O `falha` é um `*nodeapi.Error` porque a decisão de destino
// (backoff/DLQ/ignorado) é guiada pela classificação — um `error` genérico cairia no
// caso retryable e o teste não provaria a tabela.
type fakeAplica struct {
	mu        sync.Mutex
	chamadas  []nodeapi.Request
	enderecos []string
	resultado nodeapi.Result
	falha     *nodeapi.Error
	// atraso por chamada, para testar o cancelamento de contexto.
	atraso time.Duration
}

func (f *fakeAplica) ApplyEvent(_ context.Context, id string, req nodeapi.Request) (nodeapi.Result, error) {
	f.mu.Lock()
	f.chamadas = append(f.chamadas, req)
	f.enderecos = append(f.enderecos, id)
	res, falha, atraso := f.resultado, f.falha, f.atraso
	f.mu.Unlock()

	if atraso > 0 {
		time.Sleep(atraso)
	}
	if falha != nil {
		return nodeapi.Result{}, falha
	}
	return res, nil
}

func (f *fakeAplica) ApplyCharge(_ context.Context, req nodeapi.Request) (nodeapi.Result, error) {
	f.mu.Lock()
	f.chamadas = append(f.chamadas, req)
	res, falha := f.resultado, f.falha
	f.mu.Unlock()
	if falha != nil {
		return nodeapi.Result{}, falha
	}
	return res, nil
}

func (f *fakeAplica) pedidos() []nodeapi.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]nodeapi.Request(nil), f.chamadas...)
}

func (f *fakeAplica) quantasChamadas() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.chamadas)
}

// ids são os `payment_event.id` que o drain endereçou, na ordem em que chamou.
func (f *fakeAplica) ids() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.enderecos...)
}

func (f *fakeAplica) falhaCom(status int, retryable bool, msg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.falha = &nodeapi.Error{Status: status, Retryable: retryable, Message: msg}
}

// fakeGateway devolve uma resposta por `provider_order_id`, ou um erro.
type fakeGateway struct {
	mu       sync.Mutex
	charges  map[string]*charge.Charge
	erros    map[string]error
	chamadas []string
}

func (g *fakeGateway) Find(_ context.Context, id string) (*charge.Charge, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.chamadas = append(g.chamadas, id)
	if err, ok := g.erros[id]; ok {
		return nil, err
	}
	return g.charges[id], nil
}

func (g *fakeGateway) ids() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.chamadas...)
}

// -----------------------------------------------------------------------------
// utilidades
// -----------------------------------------------------------------------------

// testDB abre um pool isolado num schema único desta execução.
//
// ## Por que um schema e não um banco, e por que não só linhas com nome único
//
// A elegibilidade do drain é `status IN ('received','failed')` e a da reconciliação
// é `status = ANY('pending','processing')` — nenhuma das duas tem uma cláusula de
// tenant, porque no banco de PRODUÇÃO não existe uma: a inbox e a tabela `payment`
// são do Pagar.me inteiro. Um teste que planta uma linha e conta "quantas o ciclo
// leu" está, portanto, contando o que as OUTRAS linhas do banco têm, e o
// resultado depende do que outros testes deixaram.
//
// Isolar por sufixo de nome não resolveria (as linhas velhas também são
// elegíveis), e apagar as linhas dos outros (TRUNCATE) tornaria a suíte order
// dependent. O schema é o que dá isolamento de verdade: cada `testDB` cria um
// schema novo, aponta o `search_path` do pool para ele e cria as tabelas ali
// dentro. Nenhuma linha de fora é visível, nada é apagado, e a suíte pode rodar em
// paralelo com outra que aponte para o MESMO banco.
func testDB(t *testing.T) *sql.DB {
	t.Helper()

	dsn := os.Getenv("PAGARME_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PAGARME_TEST_DATABASE_URL não definida: suíte do drain (precisa de Postgres) pulada")
	}

	// `options=-c search_path=...` no DSN, e não um `SET search_path` por
	// conexão: o `database/sql` abre e fecha conexões o tempo todo, e um
	// `search_path` da sessão morre com a sessão. O `options` é aplicado pelo
	// servidor em CADA conexão nova, que é o que o pool precisa.
	schema := "pagarme_test_" + sufixoUnico(t)

	// Uma conexão admin (o `search_path` padrão) só para criar o schema.
	admin, err := db.Connect(dsn)
	if err != nil {
		t.Skipf("Postgres de teste não respondeu (%v): suíte do drain pulada", err)
	}
	// `t.Cleanup` e não `defer`: o `admin` tem que sobreviver ao corpo da função
	// para o cleanup do schema rodar (o `DROP` de um schema tem que vir de uma
	// conexão que NÃO está no schema). `t.Cleanup` roda em LIFO, então esta
	// registração — a primeira — é a ÚLTIMA a rodar: o schema cai com a conexão
	// ainda de pé.
	t.Cleanup(func() { _ = admin.Close() })
	if _, err := admin.Exec(`CREATE SCHEMA IF NOT EXISTS ` + pqQuoteIdent(schema)); err != nil {
		t.Fatalf("não consegui criar o schema de teste %s: %v", schema, err)
	}
	t.Cleanup(func() {
		// O schema cai junto: a suíte não deixa lixo, e um banco de teste que
		// acumula schemas para de aceitar nomes novos em algum momento.
		if _, err := admin.Exec(`DROP SCHEMA IF EXISTS ` + pqQuoteIdent(schema) + ` CASCADE`); err != nil {
			t.Logf("não consegui remover o schema de teste %s: %v", schema, err)
		}
	})

	conn, err := db.Connect(dsn + "&options=" + url.QueryEscape("-c search_path="+schema))
	if err != nil {
		t.Fatalf("não consegui abrir o pool no schema %s: %v", schema, err)
	}
	t.Cleanup(func() { conn.Close() })

	if _, err := conn.Exec(criarTabelas); err != nil {
		t.Fatalf("não consegui garantir as tabelas no banco de teste: %v", err)
	}
	return conn
}

// pqQuoteIdent protege o nome do schema. O nome é gerado por este arquivo (só
// hex, underscore e dígitos) e nunca é entrada de usuário, mas um identificador
// interpolado sem aspas é o tipo de coisa que alguém estende um dia sem perceber.
func pqQuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// criarTabelas recria `payment_event` e `payment` com os mesmos nomes de coluna do
// backend, dentro do schema isolado desta execução.
//
// `payment` aqui é o que a reconciliação lê: `id`, `provider`, `provider_order_id`,
// `status` e `created_at`. Sem FK para `order`, que a suíte não cria — e sem a
// tabela `payment_refund` e afins, que a reconciliação não toca.
const criarTabelas = `
CREATE TABLE IF NOT EXISTS payment_event (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_event_provider_event_id ON payment_event(provider, event_id);
CREATE TABLE IF NOT EXISTS payment (
	id text PRIMARY KEY,
	order_id text NOT NULL,
	provider text NOT NULL,
	provider_order_id text,
	provider_payment_id text,
	provider_charge_id text,
	method text NOT NULL DEFAULT 'pix',
	status text NOT NULL DEFAULT 'pending',
	amount real NOT NULL DEFAULT 0,
	refunded_amount real NOT NULL DEFAULT 0,
	attempt integer NOT NULL DEFAULT 1,
	qr_code text,
	qr_code_base64 text,
	qr_code_url text,
	pix_txid text,
	pix_expires_at text,
	paid_at text,
	canceled_at text,
	metadata text NOT NULL DEFAULT '{}',
	created_at text NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
	updated_at text NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_payment_status ON payment(status);
`

// sufixoUnico devolve um sufixo diferente a cada chamada.
//
// Aleatório E com contador: o aleatório evita colisão entre processos (o mesmo
// banco pode estar sendo usado por outro `go test` ao mesmo tempo), e o contador
// garante unicidade dentro do processo mesmo que o `rand` devolva o mesmo valor
// duas vezes.
var contadorUnico int32

func sufixoUnico(t *testing.T) string {
	t.Helper()
	var s [6]byte
	if _, err := rand.Read(s[:]); err != nil {
		t.Fatalf("rand falhou: %v", err)
	}
	return fmt.Sprintf("%s_%d", hex.EncodeToString(s[:]), atomic.AddInt32(&contadorUnico, 1))
}

// erroGateway monta um `*gateway.APIError`, que é o que a reconciliação classifica.
func erroGateway(status int, retryable bool) error {
	return &gateway.APIError{
		Message:   fmt.Sprintf("HTTP %d do gateway", status),
		Status:    status,
		Kind:      gateway.KindUnavailable,
		Retryable: retryable,
	}
}

// plantaEvento grava um evento na inbox e devolve o id da LINHA.
//
// A suíte não faz TRUNCATE nem DELETE: cada teste só fala das linhas que plantou,
// sem depender de o banco estar vazio e sem tocar no que outro teste deixou. O
// `seq` é deixado para o banco gerar (BIGSERIAL) porque é ele que ordena o drain.
func plantaEvento(t *testing.T, db *sql.DB, status string, attempts int, nextAttemptAt, payload string) string {
	t.Helper()
	id := "linha-" + sufixoUnico(t)
	_, err := db.Exec(`INSERT INTO payment_event
			(id, provider, event_id, event_type, payload, status, attempts, next_attempt_at, created_at)
			VALUES ($1, 'pagarme', $2, 'order.paid', $3, $4, $5, NULLIF($6, ''), '2026-10-04T12:00:00.000Z')`,
		id, "evt-"+id, payload, status, attempts, nextAttemptAt)
	if err != nil {
		t.Fatalf("não consegui plantar o evento: %v", err)
	}
	return id
}

func plantaCobranca(t *testing.T, db *sql.DB, status, providerOrderID string) string {
	t.Helper()
	id := "cob-" + sufixoUnico(t)
	_, err := db.Exec(`INSERT INTO payment (id, order_id, provider, provider_order_id, status, amount, created_at)
			VALUES ($1, 'ord-1', 'pagarme', NULLIF($2, ''), $3, 45.90, '2026-10-04T12:00:00.000Z')`,
		id, providerOrderID, status)
	if err != nil {
		t.Fatalf("não consegui plantar a cobrança: %v", err)
	}
	return id
}

// estadoDaLinha é o que o teste observa depois de um ciclo.
type estadoDaLinha struct {
	status        string
	attempts      int
	nextAttemptAt sql.NullString
	errorMessage  sql.NullString
}

func lerEstado(t *testing.T, db *sql.DB, id string) estadoDaLinha {
	t.Helper()
	var e estadoDaLinha
	if err := db.QueryRow(`SELECT status, attempts, next_attempt_at, error_message FROM payment_event WHERE id = $1`, id).
		Scan(&e.status, &e.attempts, &e.nextAttemptAt, &e.errorMessage); err != nil {
		t.Fatalf("não consegui ler a linha %s: %v", id, err)
	}
	return e
}

func payloadDe(t *testing.T, eventID, orderID, status string) string {
	t.Helper()
	m := map[string]any{
		"id":   eventID,
		"type": "order.paid",
		"data": map[string]any{
			"id": orderID,
			"payments": []any{map[string]any{
				"id": "pay_" + orderID, "status": status, "amount": 4590, "paid_amount": 4590,
			}},
		},
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("payload de teste não serializou: %v", err)
	}
	return string(b)
}

func capturaLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	original := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(original) })
	return &buf
}

func calaLog(t *testing.T) {
	t.Helper()
	original := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(original) })
}

func bancoInacessivel(t *testing.T) *sql.DB {
	t.Helper()
	inalcancavel, err := sql.Open("postgres", "postgres://pdv:pdv@127.0.0.1:1/pdv?connect_timeout=1")
	if err != nil {
		t.Fatalf("sql.Open do banco inalcançável falhou: %v", err)
	}
	t.Cleanup(func() { inalcancavel.Close() })
	return inalcancavel
}

// semGate deixa `PAGARME_DRAIN` ausente DE VERDADE. `t.Setenv` só sabe escrever
// string vazia, e string vazia é o caso "não definida" para o log — mas o teste
// do log precisa que a variável não exista, senão o `os.Getenv` não distingue.
func semGate(t *testing.T) {
	t.Helper()
	if original, ok := os.LookupEnv(drainEnv); ok {
		t.Cleanup(func() { os.Setenv(drainEnv, original) })
	} else {
		t.Cleanup(func() { os.Unsetenv(drainEnv) })
	}
	t.Setenv(drainEnv, "")
	os.Unsetenv(drainEnv)
}

// -----------------------------------------------------------------------------
// o gate
// -----------------------------------------------------------------------------

// Default-deny fecha o defeito: qualquer valor que não seja um "ligado" explícito
// deixa o drain desligado. Vale para `0`, `false` e — o caso que só aparece em
// produção — `sim`, que ligar o drain seria justamente o oposto do que a flag pede.
func TestDrainEnabledDefaultDeny(t *testing.T) {
	casos := []struct {
		raw  string
		want bool
	}{
		{"", false},
		{"0", false},
		{"false", false},
		{"FALSE", false},
		{"no", false},
		{"off", false},
		{"sim", false},
		{"2", false},
		{"  ", false},
		{"1", true},
		{" 1 ", true},
		{"true", true},
		{"TRUE", true},
		{"yes", true},
		{"on", true},
	}

	for _, c := range casos {
		t.Setenv(drainEnv, c.raw)
		if got := DrainEnabled(); got != c.want {
			t.Errorf("%s=%q: DrainEnabled() = %v, quer %v", drainEnv, c.raw, got, c.want)
		}
	}
}

func TestDrainEnabledSemVariavel(t *testing.T) {
	semGate(t)
	if DrainEnabled() {
		t.Fatalf("%s ausente e DrainEnabled() = true: o drain nasceria ligado", drainEnv)
	}
}

// -----------------------------------------------------------------------------
// Run com o gate
// -----------------------------------------------------------------------------

// Com o gate desligado o `Run` volta sem tocar no banco e sem chamar o Node. O
// banco aqui é INALCANÇÁVEL de propósito: se o guard sumisse, o ciclo abriria
// transação, levaria ECONNREFUSED e o `Run` ficaria no laço — que é o outro
// teste mostrando esse lado.
func TestRunComGateDesligadoNaoDrenaNemTocaOBanco(t *testing.T) {
	semGate(t)
	logs := capturaLog(t)
	aplica := &fakeAplica{}

	d := New(bancoInacessivel(t), aplica)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() { d.Run(ctx); close(done) }()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run não voltou com o gate desligado: entrou no laço de polling")
	}
	if n := aplica.quantasChamadas(); n != 0 {
		t.Errorf("gate desligado e %d evento(s) foram entregues ao Node", n)
	}

	saida := logs.String()
	for _, esperado := range []string{"INATIVO", drainEnv, "DLQ"} {
		if !strings.Contains(saida, esperado) {
			t.Errorf("log de boot sem %q; saída:\n%s", esperado, saida)
		}
	}
}

// O par deste: com o gate ligado, `Run` NÃO volta sozinho e volta assim que o ctx
// é cancelado. Sem esta afirmação, "voltou rápido" no teste do gate desligado
// poderia ser qualquer outra coisa.
func TestRunComGateLigadoNaoVoltaSozinhoEVoltaAoCancelar(t *testing.T) {
	calaLog(t)
	t.Setenv(drainEnv, "1")
	d := New(bancoInacessivel(t), &fakeAplica{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { d.Run(ctx); close(done) }()

	select {
	case <-done:
		t.Fatal("Run voltou sozinho com o gate ligado: o laço de polling não está rodando")
	case <-time.After(300 * time.Millisecond):
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run não voltou depois do cancelamento: goroutine pendurada")
	}
}

func TestRunComCtxJaCanceladoVolta(t *testing.T) {
	calaLog(t)
	for _, gate := range []string{"1", ""} {
		t.Run("gate="+gate, func(t *testing.T) {
			t.Setenv(drainEnv, gate)
			d := New(bancoInacessivel(t), &fakeAplica{})
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			done := make(chan struct{})
			go func() { d.Run(ctx); close(done) }()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("Run não voltou com o ctx já cancelado")
			}
		})
	}
}

// -----------------------------------------------------------------------------
// backoff
// -----------------------------------------------------------------------------

// `min(2^attempts * 30s, 15min)`, com `attempts` já incrementado — a curva do
// `requeueFailedEventUsecase`. A sequência é o contrato operacional do retry: um
// Node que reinicia às 10h:00:03 tem o evento de 10h:00:00 tentado de novo em
// 10h:01:00, não em 10h:00:02.
func TestBackoff(t *testing.T) {
	casos := []struct {
		attempts int
		quer     time.Duration
	}{
		{1, 60 * time.Second},
		{2, 120 * time.Second},
		{3, 240 * time.Second},
		{4, 480 * time.Second},
		// O teto de 15min existe no Node; com MaxAttempts=5 ele nunca é
		// alcançado na curva real, e o teste fixa isso para que um
		// `MaxAttempts` maior não produza um atraso silencioso de horas.
		{5, 900 * time.Second},
		{10, 900 * time.Second},
		{64, 900 * time.Second},
		// `attempts` 0 ou negativo não acontece em produção (o contador só
		// cresce), mas a função não pode devolver 0 nem estourar o teto errado.
		{0, 60 * time.Second},
		{-1, 60 * time.Second},
	}

	for _, c := range casos {
		if got := Backoff(c.attempts); got != c.quer {
			t.Errorf("Backoff(%d) = %v, quer %v", c.attempts, got, c.quer)
		}
	}
}

// O teto de 15min: um teto de 15 minutos é o máximo de espera entre tentativas.
// Com `MaxAttempts` maior que 5, a curva cresce até o teto e PARA — é o que
// impede um evento de atrasar horas.
func TestBackoffNuncaPassaDoTeto(t *testing.T) {
	for _, attempts := range []int{1, 2, 3, 4, 5, 6, 7, 10, 20, 62} {
		got := Backoff(attempts)
		if got > 15*time.Minute {
			t.Errorf("Backoff(%d) = %v, passou do teto de 15min", attempts, got)
		}
		if got <= 0 {
			t.Errorf("Backoff(%d) = %v: um backoff zero vira laço apertado", attempts, got)
		}
	}
}

// -----------------------------------------------------------------------------
// cargaDe
// -----------------------------------------------------------------------------

func TestCargaDe(t *testing.T) {
	// O caminho feliz: o payload do gateway vira `Charge` pelo MESMO mapper do
	// webhook.
	c, err := cargaDe(`{"id":"evt_1","type":"order.paid","data":{"id":"or_1","payments":[{"id":"pay_1","status":"paid","amount":4590}]}}`)
	if err != nil {
		t.Fatalf("cargaDe falhou: %v", err)
	}
	if c.ProviderOrderID != "or_1" || c.Status != charge.StatusPaid {
		t.Errorf("charge = %+v", c)
	}

	// E os que viram DLQ. Todos eles quebram em TODA tentativa — martelar o Node
	// com eles não conserta, e o que resolve é a reconciliação relendo o gateway.
	for _, raw := range []string{
		``,
		`   `,
		`{isto não é json`,
		`{"id":"evt_1"}`,           // sem `data`
		`{"id":"evt_1","data":{}}`, // `data` sem id
	} {
		if _, err := cargaDe(raw); err == nil {
			t.Errorf("cargaDe(%q) devolveu erro nil: esse payload é terminal e tem que ir para a DLQ", raw)
		}
	}
}

// -----------------------------------------------------------------------------
// textArray
// -----------------------------------------------------------------------------

// O literal de array é montado à mão para não espalhar a dependência do driver por
// dois pacotes. O teste fixa o formato e o escape, porque um valor com aspa seria
// injeção — mesmo que hoje os valores sejam literais do domínio.
func TestTextArray(t *testing.T) {
	casos := []struct {
		entrada []string
		quer    string
	}{
		{[]string{"pending", "processing"}, `{"pending","processing"}`},
		{nil, "{}"},
		{[]string{}, "{}"},
		{[]string{"pending"}, `{"pending"}`},
		// Aspas duplas e barra são escapadas pelo parser de array do Postgres.
		{[]string{`a"b`}, `{"a\"b"}`},
		{[]string{`a\b`}, `{"a\\b"}`},
		// Aspa simples NÃO precisa de escape (e não seria removida).
		{[]string{`a'b`}, `{"a'b"}`},
	}
	for _, c := range casos {
		if got := textArray(c.entrada); got != c.quer {
			t.Errorf("textArray(%q) = %q, quer %q", c.entrada, got, c.quer)
		}
	}
}

// E o literal tem que ser aceito pelo Postgres de verdade: um array mal formado
// faria o `ReconcileOnce` falhar em TODO ciclo, e o sintoma seria "a
// reconciliação nunca roda" sem erro em log (a falha é por linha).
func TestTextArrayEhValidoNoPostgres(t *testing.T) {
	conn := testDB(t)
	var lido string
	if err := conn.QueryRow(`SELECT array_to_string($1::text[], ',')`, textArray(pendingStatuses)).Scan(&lido); err != nil {
		t.Fatalf("o Postgres recusou o literal %q: %v", textArray(pendingStatuses), err)
	}
	if lido != "pending,processing" {
		t.Errorf("array_to_string devolveu %q, quer \"pending,processing\" — aspas simples no literal "+
			"chegariam ao valor e status = ANY() não casaria com nada", lido)
	}
}

// -----------------------------------------------------------------------------
// DrainOnce: elegibilidade (precisa de Postgres)
// -----------------------------------------------------------------------------

// Um evento novo é elegível e é entregue ao Node. É o caminho principal inteiro:
// selecionar, traduzir, entregar.
func TestDrainOnceProcessaEventoNovo(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true, Status: "paid"}}
	orderID := "or_" + sufixoUnico(t)
	linha := plantaEvento(t, conn, "received", 0, "", payloadDe(t, "evt_x", orderID, "paid"))

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if n != 1 {
		t.Fatalf("o ciclo leu %d evento(s), quer 1", n)
	}

	pedidos := aplica.pedidos()
	if len(pedidos) != 1 {
		t.Fatalf("o Node recebeu %d pedido(s), quer 1", len(pedidos))
	}
	req := pedidos[0]
	if req.Source != nodeapi.SourceEvent {
		t.Errorf("source = %q, quer %q", req.Source, nodeapi.SourceEvent)
	}
	if req.ProviderOrderID != orderID {
		t.Errorf("providerOrderId = %q, quer %q", req.ProviderOrderID, orderID)
	}
	if req.Charge == nil || req.Charge.Status != charge.StatusPaid {
		t.Errorf("charge = %+v", req.Charge)
	}
	if req.Charge.Amount != 45.90 {
		t.Errorf("charge.amount = %v, quer 45.9", req.Charge.Amount)
	}
	if req.EventID != linha {
		t.Errorf("eventId = %q, quer o id da LINHA %q", req.EventID, linha)
	}
}

// O mais importante da elegibilidade: `processing` NUNCA é selecionado.
//
// Um evento marcado `processing` que o processo não terminou é resgatado pela
// reconciliação — e é essa a razão de o Node não pegar. Aqui seria pior: como o
// apply roda no Node (outro processo), dois "consumidores" da mesma linha são duas
// transações de `applyCharge` concorrentes na mesma cobrança.
func TestDrainOnceNuncaSelecionaProcessing(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	linha := plantaEvento(t, conn, "processing", 1, "", payloadDe(t, "evt_p", "or_proc", "paid"))

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if n != 0 {
		t.Errorf("o ciclo leu %d evento(s), quer 0: 'processing' não é elegível", n)
	}
	if aplicadas := aplica.quantasChamadas(); aplicadas != 0 {
		t.Errorf("%d pedido(s) ao Node por causa de um evento em processing", aplicadas)
	}
	if e := lerEstado(t, conn, linha); e.status != "processing" {
		t.Errorf("o evento em processing foi alterado para %q", e.status)
	}
}

// `processed` e `ignored` são terminais, e a elegibilidade não os toca.
func TestDrainOnceIgnoraTerminais(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	processado := plantaEvento(t, conn, "processed", 1, "", payloadDe(t, "evt_p1", "or_t1", "paid"))
	ignorado := plantaEvento(t, conn, "ignored", 1, "", payloadDe(t, "evt_p2", "or_t2", "paid"))

	if _, err := New(conn, aplica).DrainOnce(context.Background()); err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if aplicadas := aplica.quantasChamadas(); aplicadas != 0 {
		t.Errorf("%d pedido(s) ao Node por causa de evento terminal", aplicadas)
	}
	for _, id := range []string{processado, ignorado} {
		if e := lerEstado(t, conn, id); e.status == "received" || e.status == "failed" {
			t.Errorf("evento terminal %s virou %q", id, e.status)
		}
	}
}

// `received` com `next_attempt_at` NO FUTURO não é elegível: é o backoff. Pegá-lo
// aqui seria retry apertado a cada 2s, ignorando o atraso inteiro — que é o que o
// backoff existe para fazer (não martelar um Node que está fora).
func TestDrainOnceRespeitaBackoffNaoVencido(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	futuro := time.Now().UTC().Add(10 * time.Minute).Format("2006-01-02T15:04:05.000Z")
	linha := plantaEvento(t, conn, "received", 2, futuro, payloadDe(t, "evt_b", "or_b", "paid"))

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if n != 0 {
		t.Errorf("o ciclo leu %d evento(s) com backoff de 10min, quer 0", n)
	}
	if aplicadas := aplica.quantasChamadas(); aplicadas != 0 {
		t.Errorf("%d pedido(s) ao Node com backoff pendente", aplicadas)
	}
	if e := lerEstado(t, conn, linha); e.attempts != 2 {
		t.Errorf("attempts = %d: um evento em backoff não pode ser tocado", e.attempts)
	}
}

// `failed` com backoff VENCIDO é elegível: é o retry.
func TestDrainOncePegaFailedComBackoffVencido(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	passado := time.Now().UTC().Add(-time.Minute).Format("2006-01-02T15:04:05.000Z")
	linha := plantaEvento(t, conn, "failed", 1, passado, payloadDe(t, "evt_f", "or_f", "paid"))

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if n != 1 {
		t.Fatalf("o ciclo leu %d evento(s), quer 1", n)
	}
	if aplicadas := aplica.quantasChamadas(); aplicadas != 1 {
		t.Errorf("%d pedido(s) ao Node, quer 1", aplicadas)
	}
	if e := lerEstado(t, conn, linha); e.attempts < 1 {
		t.Errorf("attempts = %d", e.attempts)
	}
}

// `failed` sem `next_attempt_at` é a DLQ, e a elegibilidade NÃO a pega: é o que
// define "fora da fila". Se pegasse, um evento que estourou o teto voltaria a ser
// martelado para sempre, e a DLQ seria só um rótulo.
func TestDrainOnceNaoPegaDLQ(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	linha := plantaEvento(t, conn, "failed", 9, "", payloadDe(t, "evt_dlq", "or_dlq", "paid"))

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if n != 0 {
		t.Errorf("o ciclo leu %d evento(s) da DLQ, quer 0", n)
	}
	if aplicadas := aplica.quantasChamadas(); aplicadas != 0 {
		t.Errorf("%d pedido(s) ao Node para um evento na DLQ", aplicadas)
	}
	if e := lerEstado(t, conn, linha); e.attempts != 9 {
		t.Errorf("attempts = %d: a DLQ não pode ser tocada por um ciclo", e.attempts)
	}
}

// A ordem é por `seq`, que é BIGSERIAL e não empata. `created_at` é texto com
// precisão de milissegundo, e dois eventos no mesmo ms empatariam num `ORDER BY`
// só por ele — e a ordem de aplicação de "pago" e "estornado" no mesmo instante
// muda o resultado final da cobrança.
func TestDrainOnceOrdenaPorSeq(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	// Mesmo `created_at` para os dois: o desempate tem que ser o `seq`.
	var ids []string
	for i := 0; i < 3; i++ {
		ids = append(ids, plantaEvento(t, conn, "received", 0, "",
			payloadDe(t, "evt_o"+string(rune('a'+i)), "or_o"+string(rune('a'+i)), "paid")))
	}

	if _, err := New(conn, aplica).DrainOnce(context.Background()); err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}

	entregues := aplica.ids()
	if len(entregues) != 3 {
		t.Fatalf("%d evento(s) entregue(s), quer 3", len(entregues))
	}
	for i := range ids {
		if entregues[i] != ids[i] {
			t.Errorf("posição %d: %q, quer %q (a ordem de aplicação importa)", i, entregues[i], ids[i])
		}
	}
}

// O lote é de 25. Um pico de 100 eventos leva 4 ciclos — e o teste existe porque
// um `LIMIT` errado (ou ausente) seria um pico de 100 chamadas HTTP ao Node dentro
// de um advisory lock.
func TestDrainOnceRespeitaOLoteDe25(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	for i := 0; i < 30; i++ {
		plantaEvento(t, conn, "received", 0, "",
			payloadDe(t, "evt_l"+fmt.Sprint(i), "or_l"+fmt.Sprint(i), "paid"))
	}

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if n != BatchSize {
		t.Errorf("o ciclo leu %d evento(s), quer %d (BatchSize)", n, BatchSize)
	}
	if chamadas := aplica.quantasChamadas(); chamadas != BatchSize {
		t.Errorf("%d chamada(s) ao Node, quer %d", chamadas, BatchSize)
	}
}

// Um evento que falha NÃO pode abortar o lote: os outros precisam ser vistos. É o
// que impede que um evento podre (payload corrompido no meio de um pico) trave a
// confirmação de todo mundo.
func TestDrainOneFalhaDeUmNaoParaOLote(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	// O primeiro evento tem payload que o mapper não entende.
	plantaEvento(t, conn, "received", 0, "", `{"id":"evt_quebrado"}`)
	plantaEvento(t, conn, "received", 0, "", payloadDe(t, "evt_ok1", "or_ok1", "paid"))
	plantaEvento(t, conn, "received", 0, "", payloadDe(t, "evt_ok2", "or_ok2", "paid"))

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("DrainOnce falhou: %v (um evento ruim não pode virar erro do ciclo)", err)
	}
	if n != 3 {
		t.Errorf("o ciclo leu %d evento(s), quer 3", n)
	}
	if chamadas := aplica.quantasChamadas(); chamadas != 2 {
		t.Errorf("%d chamada(s) ao Node, quer 2 (o quebrado não chega ao Node)", chamadas)
	}
}

// O advisory lock é o MESMO do Node (`LOCKS.paymentWorker`). Este teste segura o
// lock numa transação à parte e roda o ciclo, que tem de pular em silêncio e
// deixar a linha para o dono.
//
// Um literal de lock diferente daria dois locks que não se enxergam: os dois
// workers rodariam em paralelo e o evento seria aplicado duas vezes ao mesmo
// tempo — sem erro em log nenhum. É o teste que pega esse tipo de erro, e por
// isso ele usa o MESMO literal que o Node.
func TestDrainOncePulaQuandoOutroDrenadorTemOLock(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	linha := plantaEvento(t, conn, "received", 0, "", payloadDe(t, "evt_lk", "or_lk", "paid"))

	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("BeginTx falhou: %v", err)
	}
	defer tx.Rollback()

	var locked bool
	if err := tx.QueryRow(`SELECT pg_try_advisory_xact_lock(hashtext($1))`, lockWorker).Scan(&locked); err != nil {
		t.Fatalf("advisory lock falhou: %v", err)
	}
	if !locked {
		t.Fatal("o teste não conseguiu o lock; outro processo está usando o banco")
	}

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("perder o lock não pode ser erro: %v", err)
	}
	if n != 0 {
		t.Errorf("ciclo com o lock ocupado leu %d evento(s), quer 0", n)
	}
	if chamadas := aplica.quantasChamadas(); chamadas != 0 {
		t.Errorf("%d chamada(s) ao Node com o lock ocupado", chamadas)
	}
	if e := lerEstado(t, conn, linha); e.status != "received" || e.attempts != 0 {
		t.Errorf("a linha foi mexida por um ciclo que nem tinha o lock: %+v", e)
	}
}

// -----------------------------------------------------------------------------
// a tabela de destino de erro (precisa de Postgres)
// -----------------------------------------------------------------------------

// Esta é a parte do drain que mais importa: para onde vai cada falha. A tabela é
// `tratarErro`, e um destino errado transforma uma queda de 200ms do Node em
// retry infinito, ou um token divergente em DLQ silenciosa.
func TestDrainOnceDestinoDeCadaErro(t *testing.T) {
	casos := []struct {
		nome       string
		falha      *nodeapi.Error
		querStatus string
		querRetry  bool // tem next_attempt_at no futuro?
		querLog    string
	}{
		{
			// `failed` e não `received`: é o status que satisfaz o segundo ramo
			// da elegibilidade quando o backoff vence. Ver a nota em `reagendar`
			// sobre o bug de reenfileiramento do Node.
			nome:       "5xx volta para a fila com backoff",
			falha:      &nodeapi.Error{Status: 500, Retryable: true, Message: "boom"},
			querStatus: "failed",
			querRetry:  true,
			querLog:    "nova tentativa em",
		},
		{
			nome:       "429 volta para a fila",
			falha:      &nodeapi.Error{Status: 429, Retryable: true, Message: "rate"},
			querStatus: "failed",
			querRetry:  true,
		},
		{
			nome:       "rede volta para a fila",
			falha:      &nodeapi.Error{Status: 0, Retryable: true, Message: "ECONNREFUSED"},
			querStatus: "failed",
			querRetry:  true,
		},
		{
			nome:       "401 vai direto para a DLQ",
			falha:      &nodeapi.Error{Status: 401, Retryable: false, Message: "token"},
			querStatus: "failed",
			querRetry:  false,
			querLog:    "PAGARME_INTERNAL_TOKEN",
		},
		{
			nome:       "403 vai direto para a DLQ",
			falha:      &nodeapi.Error{Status: 403, Retryable: false, Message: "proibido"},
			querStatus: "failed",
			querRetry:  false,
		},
		{
			nome:       "422 vai para a DLQ (o conteúdo não muda com o tempo)",
			falha:      &nodeapi.Error{Status: 422, Retryable: false, Message: "status fora do vocabulário"},
			querStatus: "failed",
			querRetry:  false,
		},
		{
			nome:       "409 vai para a DLQ",
			falha:      &nodeapi.Error{Status: 409, Retryable: false, Message: "conflito"},
			querStatus: "failed",
			querRetry:  false,
		},
		{
			nome:       "404 vira ignorado, que é terminal mas não DLQ",
			falha:      &nodeapi.Error{Status: 404, Retryable: false, Message: "event_not_found"},
			querStatus: "ignored",
			querRetry:  false,
			querLog:    "não conhece a linha",
		},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			conn := testDB(t)
			logs := capturaLog(t)
			aplica := &fakeAplica{}
			aplica.falhaCom(c.falha.Status, c.falha.Retryable, c.falha.Message)

			linha := plantaEvento(t, conn, "received", 0, "", payloadDe(t, "evt_e", "or_e", "paid"))

			if _, err := New(conn, aplica).DrainOnce(context.Background()); err != nil {
				t.Fatalf("DrainOnce falhou: %v", err)
			}

			e := lerEstado(t, conn, linha)
			if e.status != c.querStatus {
				t.Errorf("status = %q, quer %q", e.status, c.querStatus)
			}
			if c.querRetry && !e.nextAttemptAt.Valid {
				t.Errorf("next_attempt_at = NULL: o evento sumiu da fila em vez de esperar o backoff")
			}
			if !c.querRetry && e.nextAttemptAt.Valid {
				t.Errorf("next_attempt_at = %q: um evento terminal tem que ficar com NULL (é assim que a elegibilidade o exclui)", e.nextAttemptAt.String)
			}
			if e.attempts != 1 {
				t.Errorf("attempts = %d, quer 1 (toda falha conta)", e.attempts)
			}
			if !e.errorMessage.Valid || e.errorMessage.String == "" {
				t.Error("error_message vazio: o operador precisa saber por que o evento parou")
			}
			if c.querLog != "" && !strings.Contains(logs.String(), c.querLog) {
				t.Errorf("log sem %q; saída:\n%s", c.querLog, logs.String())
			}
		})
	}
}

// Payload que o mapper não entende vai direto para a DLQ, sem passar pelo Node: é
// o mesmo payload em toda tentativa, e a reconciliação (que relê o gateway) é quem
// resolve.
func TestDrainOnePayloadInvalidoVaiParaDLQ(t *testing.T) {
	conn := testDB(t)
	logs := capturaLog(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	linha := plantaEvento(t, conn, "received", 0, "", `{"id":"evt_ruim"}`)

	if _, err := New(conn, aplica).DrainOnce(context.Background()); err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if chamadas := aplica.quantasChamadas(); chamadas != 0 {
		t.Errorf("payload inválido foi entregue ao Node (%d chamada(s))", chamadas)
	}
	e := lerEstado(t, conn, linha)
	if e.status != "failed" {
		t.Errorf("status = %q, quer failed", e.status)
	}
	if e.nextAttemptAt.Valid {
		t.Errorf("next_attempt_at = %q, quer NULL: payload inválido é terminal, não vai ser retentado", e.nextAttemptAt.String)
	}
	if !strings.Contains(logs.String(), "payload inválido") {
		t.Errorf("log sem explicação; saída:\n%s", logs.String())
	}
}

// -----------------------------------------------------------------------------
// DLQ ao estourar as tentativas
// -----------------------------------------------------------------------------

// O RETRY funciona de verdade — e este teste é o que prova, porque ele descobre um
// bug no Node.
//
// ## O bug que este teste encontrou
//
// A elegibilidade do Node (e deste Go, por paridade) é:
//
//	status = 'received' AND next_attempt_at IS NULL     -- evento novo
//	OU status = 'failed' AND next_attempt_at <= agora   -- backoff vencido
//
// e o `requeueFailedEventUsecase` do Node grava `status: 'received'` COM
// `next_attempt_at` no FUTURO (`payment.usecases.ts:711`). Uma linha `received`
// com `next_attempt_at` preenchida não satisfaz NENHUM dos dois ramos — então o
// evento reenfileirado pelo Node nunca mais é elegível, e a janela de retry do
// `worker.ts` está morta: a primeira falha joga o evento fora da fila para sempre
// (sem ser DLQ, sem `error_message` de teto, e sem log que denuncie).
//
// O conserto do Node (que fica para o PR de lá) é o `isNull` no predicado. O que
// este lado faz é não repetir o erro: reenfileira em `failed` com o
// `next_attempt_at` no futuro, que satisfaz o SEGUNDO ramo da elegibilidade do
// Node quando o backoff vence. Assim o retry funciona nos dois sentidos — os dois
// workers leem linhas escritas pelo outro — e a única divergência de estado é o
// rótulo (`failed` em vez de `received`), que ninguém consulta para decidir o que
// fazer.
func TestDrainOneEstouraATetoEParaNaDLQ(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{}
	aplica.falhaCom(500, true, "Node fora")

	linha := plantaEvento(t, conn, "received", 0, "", payloadDe(t, "evt_teto", "or_teto", "paid"))
	d := New(conn, aplica)

	// Tentativa 1 (attempts 0 -> 1): volta para a fila com backoff.
	if _, err := d.DrainOnce(ctx()); err != nil {
		t.Fatalf("tentativa 1: %v", err)
	}
	e := lerEstado(t, conn, linha)
	if !e.nextAttemptAt.Valid {
		t.Fatalf("tentativa 1: %+v (quer next_attempt_at no futuro)", e)
	}
	if e.attempts != 1 {
		t.Fatalf("tentativa 1: attempts = %d, quer 1", e.attempts)
	}
	// O status reenfileirado tem que satisfazer o SEGUNDO ramo da elegibilidade
	// (`status = 'failed' AND next_attempt_at <= agora`), que é o ramo que
	// realmente faz o retry acontecer. Ver a nota sobre o bug do Node no
	// comentário deste teste.
	if e.status != "failed" {
		t.Fatalf("tentativa 1: status = %q, quer failed — 'received' com next_attempt_at preenchido não é "+
			"elegível por nenhum ramo da consulta, e o evento sairia da fila para sempre", e.status)
	}

	// Tentativas 2-4: idem, e o backoff tem que CRESCER (é geométrico).
	var atrasos []time.Duration
	for i := 2; i <= 4; i++ {
		// Vence o backoff plantando `next_attempt_at` no passado.
		forcaBackoffVencido(t, conn, linha)
		if _, err := d.DrainOnce(ctx()); err != nil {
			t.Fatalf("tentativa %d: %v", i, err)
		}
		e = lerEstado(t, conn, linha)
		if e.attempts != i {
			t.Fatalf("tentativa %d: %+v (quer attempts=%d)", i, e, i)
		}
		quando, err := time.Parse("2006-01-02T15:04:05.000Z", e.nextAttemptAt.String)
		if err != nil {
			t.Fatalf("next_attempt_at %q não parseou: %v", e.nextAttemptAt.String, err)
		}
		atrasos = append(atrasos, time.Until(quando))
	}

	if atrasos[0] >= atrasos[1] || atrasos[1] >= atrasos[2] {
		t.Errorf("o backoff não cresceu: %v — um atraso constante é martelo em disguise", atrasos)
	}

	// Tentativa 5: o teto estourou e o evento é DAIXADO na DLQ.
	forcaBackoffVencido(t, conn, linha)
	if _, err := d.DrainOnce(ctx()); err != nil {
		t.Fatalf("tentativa 5: %v", err)
	}
	e = lerEstado(t, conn, linha)
	if e.status != "failed" {
		t.Fatalf("após o teto, status = %q, quer failed (DLQ)", e.status)
	}
	if e.nextAttemptAt.Valid {
		t.Errorf("next_attempt_at = %q na DLQ, quer NULL: é assim que a linha sai da fila para sempre", e.nextAttemptAt.String)
	}
	if e.attempts != MaxAttempts {
		t.Errorf("attempts = %d, quer %d", e.attempts, MaxAttempts)
	}

	// E um ciclo a mais não ressuscita a linha.
	if _, err := d.DrainOnce(ctx()); err != nil {
		t.Fatalf("ciclo pós-DLQ: %v", err)
	}
	if chamadas := aplica.quantasChamadas(); chamadas != MaxAttempts {
		t.Errorf("%d chamada(s) ao Node, quer %d: a DLQ tem que ser final", chamadas, MaxAttempts)
	}
	if e := lerEstado(t, conn, linha); e.attempts != MaxAttempts {
		t.Errorf("attempts = %d depois da DLQ: um ciclo tocou numa linha fora da fila", e.attempts)
	}
}

// forcaBackoffVencido põe `next_attempt_at` no passado, que é o estado em que a
// linha volta a ser elegível. O teste faz isso em vez de dormir porque a espera
// real seria de minutos.
func forcaBackoffVencido(t *testing.T, conn *sql.DB, linha string) {
	t.Helper()
	passado := time.Now().UTC().Add(-time.Second).Format("2006-01-02T15:04:05.000Z")
	if _, err := conn.Exec(`UPDATE payment_event SET next_attempt_at = $2 WHERE id = $1`, linha, passado); err != nil {
		t.Fatalf("não consegui vencer o backoff: %v", err)
	}
}

func ctx() context.Context { return context.Background() }

// -----------------------------------------------------------------------------
// reconciliação
// -----------------------------------------------------------------------------

// O caminho principal: uma cobrança `pending` com `provider_order_id` é relida no
// gateway e entregue ao Node COM `source=reconciliation` — que é o que faz o Node
// aplicar `canMoveTo` antes do `applyCharge`.
func TestReconcileOnceRelêPendenteEAplicaNoNode(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true, Status: "paid"}}
	orderID := "or_rec_" + sufixoUnico(t)
	cobranca := plantaCobranca(t, conn, "pending", orderID)

	gw := &fakeGateway{charges: map[string]*charge.Charge{
		orderID: {ProviderOrderID: orderID, Status: charge.StatusPaid, Amount: 45.90},
	}}

	checked, changed, err := NewReconciler(conn, aplica, gw).ReconcileOnce(context.Background())
	if err != nil {
		t.Fatalf("ReconcileOnce falhou: %v", err)
	}
	if checked != 1 || changed != 1 {
		t.Errorf("checked=%d changed=%d, quer 1/1 (a suíte planta só uma pendente)", checked, changed)
	}

	pedidos := aplica.pedidos()
	if len(pedidos) != 1 {
		t.Fatalf("o Node recebeu %d pedido(s), quer 1", len(pedidos))
	}
	if pedidos[0].Source != nodeapi.SourceReconciliation {
		t.Errorf("source = %q, quer %q: sem isto o Node não aplica a guarda de transição", pedidos[0].Source, nodeapi.SourceReconciliation)
	}
	if pedidos[0].Charge == nil || pedidos[0].Charge.Status != charge.StatusPaid {
		t.Errorf("charge = %+v", pedidos[0].Charge)
	}
	if pedidos[0].EventID != "" {
		t.Errorf("eventId = %q: a reconciliação não tem evento", pedidos[0].EventID)
	}
	_ = cobranca
}

// Status terminal não é relido: reler uma cobrança `paid` cria tráfego sem
// ganho, e reler uma `refunded` pode devolver `paid` de novo.
func TestReconcileOnceIgnoraStatusTerminais(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	gw := &fakeGateway{charges: map[string]*charge.Charge{}}

	for _, status := range []string{"paid", "failed", "canceled", "refunded", "partially_refunded"} {
		plantaCobranca(t, conn, status, "or_term_"+status+"_"+sufixoUnico(t))
	}

	checked, _, err := NewReconciler(conn, aplica, gw).ReconcileOnce(context.Background())
	if err != nil {
		t.Fatalf("ReconcileOnce falhou: %v", err)
	}
	if checked != 0 {
		t.Errorf("checked = %d: um status terminal foi relido", checked)
	}
	if chamadas := aplica.quantasChamadas(); chamadas != 0 {
		t.Errorf("%d chamada(s) ao Node para status terminal", chamadas)
	}
	if ids := gw.ids(); len(ids) != 0 {
		t.Errorf("o gateway foi consultado %d vez(es) para status terminal", len(ids))
	}
}

// Cobrança sem `provider_order_id` não tem o que reler — é o filtro
// `provider_order_id IS NOT NULL` do `pendingSelect`, que é o `if
// (!row.providerOrderId) continue` do Node.
func TestReconcileOnceIgnoraCobrancaSemOrderID(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	gw := &fakeGateway{charges: map[string]*charge.Charge{}}
	plantaCobranca(t, conn, "pending", "")

	checked, _, err := NewReconciler(conn, aplica, gw).ReconcileOnce(context.Background())
	if err != nil {
		t.Fatalf("ReconcileOnce falhou: %v", err)
	}
	if checked != 0 {
		t.Errorf("checked = %d: cobrança sem provider_order_id foi relida", checked)
	}
	if ids := gw.ids(); len(ids) != 0 {
		t.Errorf("o gateway foi consultado para uma cobrança sem id: %v", ids)
	}
}

// 404 do gateway é resultado normal: a cobrança fica como está e nenhum pedido vai
// ao Node. Viraria erro aqui, e todo ciclo encheria de alarme sem nenhum evento
// quebrado.
func TestReconcileOnceGatewayDesconheceNaoEhErro(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	orderID := "or_404_" + sufixoUnico(t)
	plantaCobranca(t, conn, "pending", orderID)
	gw := &fakeGateway{charges: map[string]*charge.Charge{}} // devolve nil

	checked, changed, err := NewReconciler(conn, aplica, gw).ReconcileOnce(context.Background())
	if err != nil {
		t.Fatalf("ReconcileOnce falhou: %v", err)
	}
	if checked != 1 || changed != 0 {
		t.Errorf("checked=%d changed=%d, quer 1/0", checked, changed)
	}
	if chamadas := aplica.quantasChamadas(); chamadas != 0 {
		t.Errorf("%d pedido(s) ao Node para uma cobrança que o gateway não conhece", chamadas)
	}
}

// Falha do gateway em UMA cobrança não derruba o ciclo: as outras precisam ser
// vistas. Duas cobranças, uma com o gateway fora.
func TestReconcileOnceFalhaDeUmaNaoParaAsOutras(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true, Status: "paid"}}
	boa := "or_ok_" + sufixoUnico(t)
	ruim := "or_bad_" + sufixoUnico(t)
	plantaCobranca(t, conn, "pending", boa)
	plantaCobranca(t, conn, "pending", ruim)

	gw := &fakeGateway{
		charges: map[string]*charge.Charge{boa: {ProviderOrderID: boa, Status: charge.StatusPaid}},
		erros:   map[string]error{ruim: erroGateway(500, true)},
	}

	checked, changed, err := NewReconciler(conn, aplica, gw).ReconcileOnce(context.Background())
	if err != nil {
		t.Fatalf("ReconcileOnce falhou: %v (uma falha por cobrança não pode virar erro do ciclo)", err)
	}
	if checked != 2 {
		t.Errorf("checked = %d, quer 2", checked)
	}
	if changed != 1 {
		t.Errorf("changed = %d, quer 1: a cobrança boa tinha que ser aplicada", changed)
	}
}

// `no_transition` é a guarda do Node funcionando: não é erro, não é retry, e o
// ciclo segue.
func TestReconcileOnceNoTransitionNaoEhErro(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: false, Reason: "no_transition"}}
	orderID := "or_nt_" + sufixoUnico(t)
	plantaCobranca(t, conn, "pending", orderID)
	gw := &fakeGateway{charges: map[string]*charge.Charge{
		orderID: {ProviderOrderID: orderID, Status: charge.StatusPending},
	}}

	checked, changed, err := NewReconciler(conn, aplica, gw).ReconcileOnce(context.Background())
	if err != nil {
		t.Fatalf("ReconcileOnce falhou: %v", err)
	}
	if checked != 1 || changed != 0 {
		t.Errorf("checked=%d changed=%d, quer 1/0", checked, changed)
	}
}

// O lock da reconciliação é SEPARADO do do drain: com o mesmo lock, um ciclo de
// reconciliação (que segura o lock durante até 20 chamadas HTTP de 15s) atrasaria o
// webhook. Este teste segura o lock do drain e prova que a reconciliação passa.
func TestReconcileOnceUsaLockDiferenteDoDrain(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true, Status: "paid"}}
	orderID := "or_lk_" + sufixoUnico(t)
	plantaCobranca(t, conn, "pending", orderID)
	gw := &fakeGateway{charges: map[string]*charge.Charge{
		orderID: {ProviderOrderID: orderID, Status: charge.StatusPaid},
	}}

	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("BeginTx falhou: %v", err)
	}
	defer tx.Rollback()
	var locked bool
	if err := tx.QueryRow(`SELECT pg_try_advisory_xact_lock(hashtext($1))`, lockWorker).Scan(&locked); err != nil {
		t.Fatalf("advisory lock falhou: %v", err)
	}
	if !locked {
		t.Fatal("o teste não conseguiu o lock do drain")
	}

	checked, _, err := NewReconciler(conn, aplica, gw).ReconcileOnce(context.Background())
	if err != nil {
		t.Fatalf("ReconcileOnce falhou: %v", err)
	}
	if checked != 1 {
		t.Errorf("checked = %d: o lock do drain bloqueou a reconciliação", checked)
	}
}

// E o inverso: segurando o lock DA RECONCILIAÇÃO, o drain tem que passar.
func TestDrainOncePassaComOLockDaReconciliacao(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true}}
	plantaEvento(t, conn, "received", 0, "", payloadDe(t, "evt_sep", "or_sep", "paid"))

	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("BeginTx falhou: %v", err)
	}
	defer tx.Rollback()
	var locked bool
	if err := tx.QueryRow(`SELECT pg_try_advisory_xact_lock(hashtext($1))`, lockReconciliation).Scan(&locked); err != nil {
		t.Fatalf("advisory lock falhou: %v", err)
	}
	if !locked {
		t.Fatal("o teste não conseguiu o lock da reconciliação")
	}

	n, err := New(conn, aplica).DrainOnce(context.Background())
	if err != nil {
		t.Fatalf("DrainOnce falhou: %v", err)
	}
	if n != 1 {
		t.Errorf("o ciclo leu %d evento(s): o lock da reconciliação bloqueou o drain", n)
	}
}

// O contador de DLQ é o único número que denuncia sozinho que a fila morta está
// crescendo, e é o que o `/health` mostra.
func TestCountDeadLettered(t *testing.T) {
	conn := testDB(t)
	r := NewReconciler(conn, &fakeAplica{}, &fakeGateway{charges: map[string]*charge.Charge{}})

	antes, err := r.CountDeadLettered(context.Background())
	if err != nil {
		t.Fatalf("CountDeadLettered falhou: %v", err)
	}

	// Uma DLQ nova e uma que NÃO é DLQ (tem backoff).
	plantaEvento(t, conn, "failed", MaxAttempts, "", payloadDe(t, "evt_dlq1", "or_d1", "paid"))
	futuro := time.Now().UTC().Add(time.Hour).Format("2006-01-02T15:04:05.000Z")
	plantaEvento(t, conn, "failed", 1, futuro, payloadDe(t, "evt_dlq2", "or_d2", "paid"))

	depois, err := r.CountDeadLettered(context.Background())
	if err != nil {
		t.Fatalf("CountDeadLettered falhou: %v", err)
	}
	if depois != antes+1 {
		t.Errorf("DLQ = %d, quer %d (só a linha sem next_attempt_at conta)", depois, antes+1)
	}
}

// `DefinirIntervalo` é o caminho da `PAGARME_RECONCILIATION_INTERVAL_MS`.
//
// O caso que importa de verdade é o valor não positivo: `time.NewTicker(0)` é
// panic imediato, e uma env com typo (`600_000`, `10m`, um espaço a mais) não
// pode derrubar o processo no boot. O método ignora o valor em vez de passar
// adiante.
func TestDefinirIntervalo(t *testing.T) {
	r := NewReconciler(nil, &fakeAplica{}, &fakeGateway{})

	if got := r.Intervalo(); got != DefaultReconciliationIntervalMS*time.Millisecond {
		t.Errorf("intervalo default = %v, quer %v", got, DefaultReconciliationIntervalMS*time.Millisecond)
	}

	r.DefinirIntervalo(90 * time.Second)
	if got := r.Intervalo(); got != 90*time.Second {
		t.Errorf("intervalo = %v, quer 90s", got)
	}

	// Valores que não podem virar um ticker.
	for _, ruim := range []time.Duration{0, -time.Second, -time.Hour} {
		r.DefinirIntervalo(ruim)
		if got := r.Intervalo(); got != 90*time.Second {
			t.Errorf("DefinirIntervalo(%v) mudou o intervalo para %v: precisa ignorar, senão vira ticker(0) no Run", ruim, got)
		}
	}
}

// O teto de 20 existe porque cada item é uma chamada HTTP com timeout de 15s: sem
// teto, uma fila grande seguraria o advisory lock por horas.
func TestReconcileOnceRespeitaOLimite(t *testing.T) {
	conn := testDB(t)
	aplica := &fakeAplica{resultado: nodeapi.Result{Applied: true, Status: "paid"}}
	gw := &fakeGateway{charges: map[string]*charge.Charge{}}
	for i := 0; i < ReconciliationLimit+5; i++ {
		id := "or_lim_" + fmt.Sprint(i) + "_" + sufixoUnico(t)
		plantaCobranca(t, conn, "pending", id)
		gw.charges[id] = &charge.Charge{ProviderOrderID: id, Status: charge.StatusPaid}
	}

	checked, _, err := NewReconciler(conn, aplica, gw).ReconcileOnce(context.Background())
	if err != nil {
		t.Fatalf("ReconcileOnce falhou: %v", err)
	}
	if checked > ReconciliationLimit {
		t.Errorf("checked = %d, quer no máximo %d", checked, ReconciliationLimit)
	}
}
