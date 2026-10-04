package outbox

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"pdv-ws-gateway/internal/db"
)

// =============================================================================
// Suíte do dispatcher
//
// Duas camadas, porque nem tudo aqui precisa de banco:
//
// 1. O GATE (`WS_DISPATCH`) e o `Run` — sem banco nenhum. O ponto é que com o
//    gate desligado o dispatcher não pode nem tentar abrir transação, e a
//    prova disso não é "não logou": é o par de testes com banco INALCANÇÁVEL,
//    onde `Run` com o gate ligado não volta e com o gate desligado volta
//    na hora. Se o guard sumisse, o teste do gate desligado passaria a rodar o
//    laço e travaria no timeout — não a falhar em silêncio.
//
// 2. O CICLO (`PollOnce`) — precisa de Postgres de verdade, porque o que está
//    em jogo é a coluna `published`, e um mock não prova nada sobre advisory
//    lock, transação e `UPDATE`. Esses testes pulam sem
//    `WS_GATEWAY_TEST_DATABASE_URL`. O job `test-ws-gateway` do CI (tests.yml)
//    SOBE um serviço `postgres:16` e passa a variável, então lá os cinco rodam
//    — e um passo seguinte quebra o job se algum pular, porque um `t.Skip` é
//    verde sem ter testado nada. Localmente:
//
//	WS_GATEWAY_TEST_DATABASE_URL='postgres://pdv:pdv@localhost:5432/pdv?sslmode=disable' \
//	  go test -race -count=1 ./internal/outbox/
//
// O `?sslmode=disable` é obrigatório, não decoração: o driver daqui é o
// `lib/pq` (`internal/db`), que assume `sslmode=require` quando a DSN não diz
// nada, e um Postgres de dev comum não tem SSL — sem o parâmetro os cinco
// testes pulam com "pq: SSL is not enabled on the server", ou seja, env setada,
// suíte verde e nada exercitado. A DSN do job `test-backend` dispensa o
// parâmetro porque o driver do Node (`pg`) negocia para texto puro; por isso
// copiar a DSN dela para cá, sem acrescentar nada, reproduz o pulo silencioso.
//
// O banco tem que ser DEDICADO a esta suíte: os testes publicam de verdade e
// disputam o advisory lock `pdv:outbox:owner`, o mesmo do backend (ver
// PollOnce). Com um dispatcher do Node rodando no mesmo banco, os ciclos se
// alternam e o lote plantado some.
// =============================================================================

// -----------------------------------------------------------------------------
// doubles
// -----------------------------------------------------------------------------

// recordingHub é o hub do dispatcher em miniatura: devolve quantas conexões
// receberam o frame e guarda o que cada room recebeu. `assinar` é o cliente
// que entrou na room; sem ele a entrega é 0, que é o caso "nenhum assinante" —
// um estado legítimo, tratado como paridade com o Node (ver Dispatcher.publish).
type recordingHub struct {
	mu        sync.Mutex
	assinados map[string]int
	recebidos map[string][][]byte
}

func newRecordingHub() *recordingHub {
	return &recordingHub{
		assinados: make(map[string]int),
		recebidos: make(map[string][][]byte),
	}
}

func (h *recordingHub) assinar(room string, conexoes int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.assinados[room] = conexoes
}

func (h *recordingHub) BroadcastToRoom(room string, payload []byte) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.assinados[room] == 0 {
		return 0
	}
	// Cópia: o frame é reutilizado entre ciclos no código real, e guardar o
	// slice sem copiar transformaria uma otimização do hub em bug do teste.
	frame := make([]byte, len(payload))
	copy(frame, payload)
	h.recebidos[room] = append(h.recebidos[room], frame)
	return h.assinados[room]
}

// frames devolve o que a room recebeu, na ordem.
func (h *recordingHub) frames(room string) [][]byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([][]byte(nil), h.recebidos[room]...)
}

func (h *recordingHub) total() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, frames := range h.recebidos {
		n += len(frames)
	}
	return n
}

// -----------------------------------------------------------------------------
// utilidades
// -----------------------------------------------------------------------------

// bancoInacessivel devolve um *sql.DB que responde erro em qualquer query.
//
// Existe para os testes de gate não dependerem de rede: `sql.Open` é preguiçoso
// (não conecta) e o primeiro uso morre na hora em `127.0.0.1:1` (ECONNREFUSED
// em loopback é imediato). O driver "postgres" fica registrado porque este
// arquivo importa `internal/db`, que o registra no init.
func bancoInacessivel(t *testing.T) *sql.DB {
	t.Helper()
	inalcancavel, err := sql.Open("postgres", "postgres://pdv:pdv@127.0.0.1:1/pdv?connect_timeout=1")
	if err != nil {
		t.Fatalf("sql.Open do banco inalcançável falhou: %v", err)
	}
	t.Cleanup(func() { inalcancavel.Close() })
	return inalcancavel
}

// semGate deixa `WS_DISPATCH` ausente de verdade. `t.Setenv` só sabe escrever
// string vazia, e string vazia é o caso "não definida" para o log — mas o
// teste do log precisa que a variável não exista, senão o `os.Getenv` não
// distingue. O cleanup do t.Setenv restaura o valor original, então a ordem
// entre os dois não importa.
func semGate(t *testing.T) {
	t.Helper()
	if original, ok := os.LookupEnv(dispatchEnv); ok {
		t.Cleanup(func() { os.Setenv(dispatchEnv, original) })
	} else {
		t.Cleanup(func() { os.Unsetenv(dispatchEnv) })
	}
	t.Setenv(dispatchEnv, "")
	os.Unsetenv(dispatchEnv)
}

// capturaLog redirects o log padrão durante o teste. O "por que" do dispatcher
// inativo só existe em log — é o que o operador vai ler quando o bell do salão
// não tocar, então ele é parte do contrato, não ruído.
func capturaLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	original := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(original) })
	return &buf
}

// calaLog esconde o erro de conexão esperado dos testes que usam
// bancoInacessivel: eles provocam a falha de propósito, e ela não é a
// asserção.
func calaLog(t *testing.T) {
	t.Helper()
	original := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(original) })
}

// -----------------------------------------------------------------------------
// o gate
// -----------------------------------------------------------------------------

// Default-deny é a propriedade que fecha o defeito: qualquer valor que não
// seja um "ligado" explícito deixa o dispatcher desligado. Vale para `0`,
// `false` e — o caso que só aparece em produção — valor digitado errado
// (`WS_DISPATCH=sim`), que ligar o dispatcher seria justamente o oposto do que
// a flag pede.
func TestDispatchEnabledDefaultDeny(t *testing.T) {
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
		{"sim", false}, // não é "sim" em inglês, e value aqui é desligado
		{"2", false},   // número ≠ 1 não liga: nenhuma flag do serviço faz isso
		{"  ", false},
		{"1", true},
		{" 1 ", true},
		{"true", true},
		{"TRUE", true},
		{"yes", true},
		{"on", true},
	}

	for _, c := range casos {
		t.Setenv(dispatchEnv, c.raw)
		if got := DispatchEnabled(); got != c.want {
			t.Errorf("%s=%q: DispatchEnabled() = %v, quer %v", dispatchEnv, c.raw, got, c.want)
		}
	}
}

// A variável ausente é o estado do serviço recém-subido: o compose não define
// `WS_DISPATCH` em lugar nenhum hoje, então o dispatcher tem que nascer
// desligado sem depender de ninguém lembrar de escrever "0".
func TestDispatchEnabledSemVariavel(t *testing.T) {
	semGate(t)
	if DispatchEnabled() {
		t.Fatalf("%s ausente e DispatchEnabled() = true: o dispatcher nasceria ligado", dispatchEnv)
	}
}

// -----------------------------------------------------------------------------
// Run com o gate desligado
// -----------------------------------------------------------------------------

// Com o gate desligado, `Run` volta sem publicar e sem tocar no banco — o
// `published = false` de toda linha pendente é a consequência que importa em
// produção, e ela vem de não haver escrita nenhuma. O banco aqui é
// inalcançável de propósito: se o guard sumisse, o ciclo abriria transação,
// levaria ECONNREFUSED e o Run ficaria no laço (é o outro teste, o do gate
// ligado, que mostra esse lado).
func TestRunComGateDesligadoNaoPublicaNemTocaOBanco(t *testing.T) {
	semGate(t)
	logs := capturaLog(t)

	hub := newRecordingHub()
	d := New(bancoInacessivel(t), hub)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		d.Run(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run não voltou com o gate desligado: entrou no laço de polling")
	}

	if total := hub.total(); total != 0 {
		t.Errorf("gate desligado e %d frame(s) foram entregues a alguém", total)
	}

	// O log tem que dizer que está inativo E por quê — o caso patológico é
	// gateway de pé, banco respondendo e nenhum evento, sem nenhuma pista de
	// onde olhar.
	saida := logs.String()
	for _, esperado := range []string{"dispatcher INATIVO", dispatchEnv, "/realtime"} {
		if !strings.Contains(saida, esperado) {
			t.Errorf("log de boot sem %q; saída:\n%s", esperado, saida)
		}
	}
}

// Valor de flag inesperado também tem que explicar: quem digita `WS_DISPATCH=sim`
// precisa ver o valor lido no log, senão o silêncio volta a ser a única
// evidência.
//
// `Run` roda em goroutine com prazo, e não na Calling goroutine: se o gate
// deixar de existir, a chamada não volta nunca, e um teste que trava é pior que
// um teste que falha — ele leva o timeout inteiro da suíte e não diz o quê.
func TestRunComGateDesligadoExplicaValorInvalido(t *testing.T) {
	t.Setenv(dispatchEnv, "sim")
	logs := capturaLog(t)

	d := New(bancoInacessivel(t), newRecordingHub())

	done := make(chan struct{})
	go func() {
		d.Run(context.Background())
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal(`Run com WS_DISPATCH=sim entrou no laço de polling: valor inválido não pode ligar o dispatcher`)
	}

	saida := logs.String()
	if !strings.Contains(saida, `"sim"`) {
		t.Errorf("log de boot não traz o valor lido; saída:\n%s", saida)
	}
}

// -----------------------------------------------------------------------------
// Run com o gate ligado
// -----------------------------------------------------------------------------

// O par deste com o teste do gate desligado: com o gate ligado, `Run` NÃO
// volta sozinho (ficaDoing polling até o ctx morrer) e volta assim que o ctx é
// cancelado. Sem esta afirmação, "voltou rápido" no teste do gate desligado
// poderia ser qualquer outra coisa — inclusive um Run que simplesmente_enqueue
// saiu.
func TestRunComGateLigadoNaoVoltaSozinhoEVoltaAoCancelar(t *testing.T) {
	t.Setenv(dispatchEnv, "1")
	calaLog(t)

	hub := newRecordingHub()
	d := New(bancoInacessivel(t), hub)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		d.Run(ctx)
		close(done)
	}()

	select {
	case <-done:
		t.Fatal("Run voltou sozinho com o gate ligado: o laço de polling não está rodando")
	case <-time.After(300 * time.Millisecond):
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run não voltou depois do cancelamento do ctx: goroutine pendurada")
	}
}

// `Run` com o ctx já cancelado no boot tem que voltar também: o `main.go` sobe
// o dispatcher numa goroutine e o SIGTERM pode chegar antes do primeiro tick.
// Sem este caso, um Run travado nesse instante só apareceria como goroutine
// pendurada no shutdown.
func TestRunComCtxJaCanceladoVolta(t *testing.T) {
	calaLog(t)

	for _, gate := range []string{"1", ""} {
		t.Run("gate="+gate, func(t *testing.T) {
			t.Setenv(dispatchEnv, gate)
			d := New(bancoInacessivel(t), newRecordingHub())

			ctx, cancel := context.WithCancel(context.Background())
			cancel()

			done := make(chan struct{})
			go func() {
				d.Run(ctx)
				close(done)
			}()

			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("Run não voltou com o ctx já cancelado")
			}
		})
	}
}

// -----------------------------------------------------------------------------
// PollOnce: o gate é do caminho que escreve `published`
// -----------------------------------------------------------------------------

// O guard está em `PollOnce`, não só em `Run`: quem chama o ciclo direto
// (teste, script, worker novo) não pode publicar sem o gate. Sem banco
// alcançável, o par com o teste seguinte é a prova.
func TestPollOnceComGateDesligadoNaoConsultaNemErra(t *testing.T) {
	semGate(t)
	calaLog(t)

	d := New(bancoInacessivel(t), newRecordingHub())
	n, err := d.PollOnce(context.Background())

	if err != nil {
		t.Fatalf("gate desligado não deveria tocar o banco, e veio erro: %v", err)
	}
	if n != 0 {
		t.Fatalf("gate desligado e o ciclo leu %d evento(s)", n)
	}
}

// O complemento do teste acima: aqui o MESMO banco inalcançável devolve erro,
// o que prova que o `nil` do teste do gate desligado é o gate decidindo e não
// um banco quebrado passando batido.
func TestPollOnceComGateLigadoFalhaQuandoOBancoNaoResponde(t *testing.T) {
	t.Setenv(dispatchEnv, "1")
	calaLog(t)

	d := New(bancoInacessivel(t), newRecordingHub())
	if _, err := d.PollOnce(context.Background()); err == nil {
		t.Fatal("gate ligado e banco inalcançável: erro nil significa que o ciclo nem tentou o banco")
	}
}

// -----------------------------------------------------------------------------
// PollOnce: precisa de Postgres (pula sem WS_GATEWAY_TEST_DATABASE_URL)
// -----------------------------------------------------------------------------

func TestPollOnceComGateDesligadoDeixaLinhaPendente(t *testing.T) {
	db := testDB(t)
	semGate(t)

	id, _ := plantaPendente(t, db, "order.created", `{"orderId":"abc"}`)
	hub := newRecordingHub()

	n, err := New(db, hub).PollOnce(context.Background())
	if err != nil {
		t.Fatalf("PollOnce falhou: %v", err)
	}
	if n != 0 {
		t.Errorf("gate desligado e o ciclo leu %d evento(s); esperava 0", n)
	}
	if publicado(t, db, id) {
		t.Fatalf("gate desligado e o evento %s foi marcado publicado — é exatamente o defeito que o gate existe para impedir", id)
	}
	if total := hub.total(); total != 0 {
		t.Errorf("gate desligado e %d frame(s) foram entregues", total)
	}
}

// Gate ligado: o caminho feliz continua igual ao de antes do gate — o evento
// vai para a room e a linha sai da fila.
func TestPollOnceComGateLigadoPublicaParaAssinante(t *testing.T) {
	db := testDB(t)
	t.Setenv(dispatchEnv, "1")

	id, room := plantaPendente(t, db, "order.item.created", `{"itemId":"i1","qty":2}`)
	hub := newRecordingHub()
	hub.assinar(room, 1)

	if _, err := New(db, hub).PollOnce(context.Background()); err != nil {
		t.Fatalf("PollOnce falhou: %v", err)
	}

	frames := hub.frames(room)
	if len(frames) != 1 {
		t.Fatalf("room %s recebeu %d frame(s), quer 1", room, len(frames))
	}

	var envelope struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(frames[0], &envelope); err != nil {
		t.Fatalf("frame não é JSON válido: %v (%s)", err, frames[0])
	}
	if envelope.Type != "order.item.created" {
		t.Errorf("type = %q, quer order.item.created", envelope.Type)
	}
	var payload map[string]any
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		t.Fatalf("payload não é JSON válido: %v", err)
	}
	if payload["itemId"] != "i1" {
		t.Errorf("payload = %v, quero itemId=i1", payload)
	}
	if !publicado(t, db, id) {
		t.Errorf("evento %s continua pendente depois de entregue", id)
	}
}

// Paridade com o Node (`pollOutboxOnce`): evento sem assinante é marcado
// publicado do mesmo jeito. Zero assinante aqui é "ninguém olhando a room
// agora" — o que só é verdade porque o gate garante que este processo é o dono
// do `/realtime`. Sem o gate, o mesmo caminho é o que engole o evento de quem
// está conectado no outro servidor, em silêncio.
func TestPollOnceComGateLigadoMarcaPublicadoSemAssinante(t *testing.T) {
	db := testDB(t)
	t.Setenv(dispatchEnv, "1")

	id, room := plantaPendente(t, db, "alert.triggered", `{"kind":"bell"}`)
	hub := newRecordingHub() // ninguém assinou

	if _, err := New(db, hub).PollOnce(context.Background()); err != nil {
		t.Fatalf("PollOnce falhou: %v", err)
	}

	if !publicado(t, db, id) {
		t.Fatalf("evento %s sem assinante ficou pendente: isso cria retry a cada 200ms e diverge do Node", id)
	}
	if frames := hub.frames(room); len(frames) != 0 {
		t.Errorf("room sem assinante recebeu %d frame(s)", len(frames))
	}
}

// Paridade com o Node também no payload corrompido: descartado E marcado
// publicado. Deixar pendente transformaria uma linha irrecuperável em retry
// apertado para sempre, e o dispatcher é serial — o loop de 200ms não dá folga
// nem para o resto da fila.
func TestPollOnceComGateLigadoMarcaPublicadoPayloadCorrompido(t *testing.T) {
	db := testDB(t)
	t.Setenv(dispatchEnv, "1")

	id, room := plantaPendente(t, db, "order.created", `{"orderId": "truncado`)
	hub := newRecordingHub()
	hub.assinar(room, 1)

	if _, err := New(db, hub).PollOnce(context.Background()); err != nil {
		t.Fatalf("PollOnce falhou: %v", err)
	}

	if !publicado(t, db, id) {
		t.Fatalf("evento %s com payload corrompido ficou pendente: retry apertado garantido", id)
	}
	if frames := hub.frames(room); len(frames) != 0 {
		t.Errorf("payload corrompido foi entregue: %d frame(s)", len(frames))
	}
}

// O que o advisory lock realmente garante: dois dispatchers no MESMO banco não
// publicam o mesmo evento. Segura o lock numa transação à parte e roda o ciclo
// do dispatcher — que tem de pular em silêncio (0, sem erro) deixando a linha
// para o dono do lock. É a mútua exclusão que o lock promete; a posse do
// realtime é outra história (gate.go).
func TestPollOncePulaQuandoOutroDispatcherTemOLock(t *testing.T) {
	db := testDB(t)
	t.Setenv(dispatchEnv, "1")

	id, _ := plantaPendente(t, db, "order.created", `{"orderId":"abc"}`)

	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("BeginTx falhou: %v", err)
	}
	defer tx.Rollback()

	var locked bool
	if err := tx.QueryRow(`SELECT pg_try_advisory_xact_lock(hashtext($1))`, lockName).Scan(&locked); err != nil {
		t.Fatalf("advisory lock falhou: %v", err)
	}
	if !locked {
		t.Fatal("o teste não conseguiu o lock; outro dispatcher está usando o banco")
	}

	hub := newRecordingHub()
	n, err := New(db, hub).PollOnce(context.Background())
	if err != nil {
		t.Fatalf("perder o lock não pode ser erro: %v", err)
	}
	if n != 0 {
		t.Errorf("ciclo com o lock ocupado leu %d evento(s), quer 0", n)
	}
	if publicado(t, db, id) {
		t.Errorf("evento %s foi publicado por um dispatcher que nem tinha o lock", id)
	}
	if total := hub.total(); total != 0 {
		t.Errorf("lock ocupado e %d frame(s) foram entregues", total)
	}
}

// -----------------------------------------------------------------------------
// helpers de banco
// -----------------------------------------------------------------------------

func testDB(t *testing.T) *sql.DB {
	t.Helper()

	dsn := os.Getenv("WS_GATEWAY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("WS_GATEWAY_TEST_DATABASE_URL não definida: suíte de PollOnce (precisa de Postgres) pulada")
	}

	// `internal/db` em vez de `sql.Open` direto: é o mesmo caminho do binário
	// (mesmo driver, mesmo ping, mesmos limites de pool) e evita declarar
	// dependência de lib/pq que só existe para isto.
	conn, err := db.Connect(dsn)
	if err != nil {
		t.Skipf("Postgres de teste não respondeu (%v): suíte de PollOnce pulada", err)
	}
	t.Cleanup(func() { conn.Close() })

	if _, err := conn.Exec(criarOutboxTable); err != nil {
		t.Fatalf("não consegui garantir a tabela outbox_event no banco de teste: %v", err)
	}
	return conn
}

// criarOutboxTable é a tabela que o dispatcher lê, com os mesmos nomes de
// coluna do backend (backend/migrations/0001_init.sql). `IF NOT EXISTS` de
// propósito: quem apontar a env para um banco que já tem a tabela real do
// migrate usa a real.
const criarOutboxTable = `CREATE TABLE IF NOT EXISTS outbox_event (
	id text PRIMARY KEY,
	seq bigint NOT NULL,
	event_type text NOT NULL,
	payload text NOT NULL,
	room text NOT NULL,
	published boolean NOT NULL DEFAULT false,
	created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text)
)`

// plantaPendente grava uma linha como o backend grava (a intenção de emitir
// entra na mesma transação da escrita, com `published = false`) e devolve id e
// room. Id e room são únicos por chamada: a suíte não faz TRUNCATE nem DELETE
// nada, então cada teste só fala das linhas que plantou — sem depender de o
// banco estar vazio e sem tocar no que outro teste deixou.
func plantaPendente(t *testing.T, db *sql.DB, eventType, payload string) (id, room string) {
	t.Helper()

	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatalf("rand falhou: %v", err)
	}
	id = "outbox-test-" + hex.EncodeToString(suffix[:])
	room = "outbox-test:" + id

	_, err := db.Exec(
		`INSERT INTO outbox_event (id, seq, event_type, payload, room) VALUES ($1, $2, $3, $4, $5)`,
		id, time.Now().UnixNano(), eventType, payload, room,
	)
	if err != nil {
		t.Fatalf("não consegui plantar o evento pendente: %v", err)
	}
	return id, room
}

// publicado lê a coluna que decide se o evento ainda existe para alguém.
func publicado(t *testing.T, db *sql.DB, id string) bool {
	t.Helper()

	var valor bool
	if err := db.QueryRow(`SELECT published FROM outbox_event WHERE id = $1`, id).Scan(&valor); err != nil {
		t.Fatalf("não consegui ler published de %s: %v", id, err)
	}
	return valor
}

// =============================================================================
// Envelope (função pura, sem banco e sem env)
// =============================================================================

// Envelope tem que ter `emittedAt` no mesmo formato do Node (milissegundos
// sempre, UTC). O cliente compara e ordena por string muitas vezes, e usar
// RFC3339 sem forçar 3 dígitos mascara divergência.
func TestEnvelopeFormato(t *testing.T) {
	b, err := Envelope("order.created", json.RawMessage(`{"orderId":"x"}`))
	if err != nil {
		t.Fatalf("Envelope falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("payload inválido: %v", err)
	}
	if _, ok := m["emittedAt"]; !ok {
		t.Fatal("emittedAt ausente")
	}
	em, ok := m["emittedAt"].(string)
	if !ok {
		t.Fatal("emittedAt não é string")
	}
	// yyyy-mm-ddTHH:MM:SS.000Z — exatamente 3 dígitos de ms
	if len(em) != 24 {
		t.Errorf("tamanho do emittedAt inesperado: %d, quer 24 (yyyy-mm-ddTHH:MM:SS.000Z); valor=%q", len(em), em)
	}
	if em[len(em)-1] != 'Z' || em[4] != '-' || em[10] != 'T' || em[19] != '.' {
		t.Errorf("formato do emittedAt fora do padrão: %q (esperado 2025-10-04T12:00:00.000Z)", em)
	}
	if _, ok := m["type"]; !ok {
		t.Fatal("type ausente")
	}
	if m["type"] != "order.created" {
		t.Errorf("type=%q", m["type"])
	}
}

// Quando o payload for vazio, o envelope tem que conter `payload: null` para o
// cliente não ficar com `undefined`.
func TestEnvelopePayloadNulo(t *testing.T) {
	b, err := Envelope("sync.response", json.RawMessage(``))
	if err != nil {
		t.Fatalf("Envelope falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("payload inválido: %v", err)
	}
	if m["payload"] != nil {
		t.Errorf("payload deve ser null, mas é %T/%v", m["payload"], m["payload"])
	}
}
