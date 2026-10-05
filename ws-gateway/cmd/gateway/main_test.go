package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pdv-ws-gateway/internal/connmanager"
)

// budgetHealth é o teto que o handler precisa cumprir.
//
// Os consumidores reais são mais apertados que isto: `deploy/switch.sh` e
// `deploy/probe-availability.sh` usam `curl -fsS -m 2`, e o healthcheck do
// Docker usa `timeout: 5s`. O teste segura 500ms para não ficar instável em
// máquina carregada — que ainda é 4× mais apertado que o switch.sh.
const budgetHealth = 500 * time.Millisecond

// pingerFake responde o que o teste mandar. Substitui o pool no lugar do único
// método que o /health usa (ver dbPinger).
//
// `preso` é o botão do banco congelado: enquanto estiver ligado, o ping ignora
// o prazo do contexto e não volta. É o que o lib/pq faz contra um Postgres com
// `docker pause`, e é o comportamento que precisa estar travado no teste — se o
// ping respeitasse o deadline, o bug original passaria despercebido.
type pingerFake struct {
	mu    sync.Mutex
	err   error
	preso bool
	gave  chan struct{} // fechado quando um ping preso é liberado
	calls atomic.Int64
}

func (p *pingerFake) PingContext(ctx context.Context) error {
	p.calls.Add(1)

	p.mu.Lock()
	preso, err, gave := p.preso, p.err, p.gave
	p.mu.Unlock()

	if preso {
		<-gave // de propósito sem `select` no ctx: o driver real também ignora
		return errors.New("conexão devolvida pelo teste")
	}
	return err
}

func (p *pingerFake) setErr(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.err = err
}

// destrava faz os pings presos voltarem, como um Postgres que sai do `docker
// pause`.
func (p *pingerFake) destrava() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.preso = false
	p.err = nil
	close(p.gave)
}

// novoPingerPreso devolve um pinger que trava de propósito. O canal só é
// fechado por destrava(), então sem destravar o ping é preso para sempre.
func novoPingerPreso() *pingerFake {
	return &pingerFake{preso: true, gave: make(chan struct{})}
}

// novoServerDeTeste monta o servidor com hub real (o /health lê as contagens
// dele) e o probe do banco.
func novoServerDeTeste(p dbPinger) *server {
	return &server{
		hub:     connmanager.New(),
		health:  newHealthProbe(p, time.Now()),
		started: time.Now(),
		version: "teste",
	}
}

// novoProbeCurto monta um probe com os prazos de produção encolhidos para
// milissegundos, para o teste não dormir segundos.
func novoProbeCurto(p dbPinger, staleAfter time.Duration) *healthProbe {
	pr := newHealthProbe(p, time.Now())
	pr.poll = 5 * time.Millisecond
	pr.timeout = 5 * time.Millisecond
	pr.staleAfter = staleAfter
	return pr
}

// chamaHealth roda o handler e devolve código, corpo decodificado e quanto
// tempo levou.
func chamaHealth(t *testing.T, s *server) (int, map[string]any, time.Duration) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	start := time.Now()
	s.handleHealth(rec, req)
	elapsed := time.Since(start)

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("resposta não é JSON: %v (corpo: %s)", err, rec.Body.String())
	}
	return rec.Code, body, elapsed
}

// --- caso 1: banco respondendo --------------------------------------------

func TestHandleHealthBancoOKResponde200(t *testing.T) {
	t.Setenv(envDispatch, "1") // pool + gate: o estado verdadeiramente saudável

	s := novoServerDeTeste(&pingerFake{})
	s.health = novoProbeCurto(s.health.db, time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.health.run(ctx)

	code, body, elapsed := chamaHealth(t, s)
	if code != http.StatusOK {
		t.Fatalf("com banco respondendo o /health tem de ser 200, veio %d (%v)", code, body)
	}
	if body["status"] != "ok" {
		t.Errorf("status esperado \"ok\", veio %q", body["status"])
	}
	if body["outboxEnabled"] != true {
		t.Errorf("outboxEnabled deveria ser true com pool e gate ligado, veio %v", body["outboxEnabled"])
	}
	if _, tem := body["databaseError"]; tem {
		t.Errorf("não deve haver databaseError com banco respondendo, veio %q", body["databaseError"])
	}
	if elapsed > budgetHealth {
		t.Errorf("respondeu em %v, acima do orçamento de %v", elapsed, budgetHealth)
	}
}

// --- caso 2: banco recusando (o que já funcionava) -------------------------

func TestHandleHealthBancoComErroResponde503Rapido(t *testing.T) {
	fake := &pingerFake{}
	fake.setErr(errors.New("dial tcp 127.0.0.1:5432: connect: connection refused"))
	s := novoServerDeTeste(fake)
	s.health = novoProbeCurto(fake, time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.health.run(ctx)

	// Espera o fundo registrar o erro: o handler só lê, ele não pergunta.
	esperaProbe(t, s, func() bool { return s.health.check().dbErr != nil },
		"o probe de fundo não registrou o erro do driver")

	code, body, elapsed := chamaHealth(t, s)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("com banco recusando o /health tem de ser 503, veio %d (%v)", code, body)
	}
	if body["status"] != "degraded" {
		t.Errorf("status esperado \"degraded\", veio %q", body["status"])
	}
	// O texto do driver preserva: quem lia `databaseError` continua vendo a
	// causa real (recusado ≠ travado).
	want := "dial tcp 127.0.0.1:5432: connect: connection refused"
	if body["databaseError"] != want {
		t.Errorf("databaseError esperado %q, veio %q", want, body["databaseError"])
	}
	if elapsed > budgetHealth {
		t.Errorf("respondeu em %v, acima do orçamento de %v", elapsed, budgetHealth)
	}
}

// --- caso 3: o defeito — banco travado, driver que nunca volta ------------

// Este é o teste que trava o comportamento no CI.
//
// Um pinger que ignora o prazo do contexto representa o Postgres congelado: a
// conexão TCP está aberta, o servidor não responde e o lib/pq não volta. O
// handler precisa responder 503 dentro do orçamento mesmo assim, porque o
// `http.Server` não tem ReadTimeout/WriteTimeout que segurem isso (a conexão
// WebSocket escapa do server no hijack do upgrade) e `curl -m 2` do switch.sh
// só dá 2s.
func TestHandleHealthBancoTravadoResponde503NoPrazo(t *testing.T) {
	// O ping trava de propósito e nunca volta, igual ao driver contra um banco
	// congelado.
	fake := novoPingerPreso()
	s := novoServerDeTeste(fake)

	// O último "ok" envelhece rápido, para não esperar seconds no teste.
	s.health = novoProbeCurto(fake, 30*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.health.run(ctx)

	// Primeiro o fundo precisa mesmo tentar o banco — e ficar preso nela. É o
	// estado que o `docker pause` produz: a tentativa começou e não voltou.
	esperaProbe(t, s, func() bool { return s.health.check().inFlight > 0 },
		"o probe nunca chegou a tentar o banco")

	// Agora espera o último "ok" envelhecer. O ping está preso, então nenhum
	// probe novo completa e o estado tem de envelhecer sozinho: é o tempo, e
	// não o driver, que degrada o /health.
	esperaProbe(t, s, func() bool { return !s.health.check().ok },
		"o /health continuou 200 com o banco travado")

	// A resposta que importa: dentro do orçamento, e sem mentir 200.
	code, body, elapsed := chamaHealth(t, s)
	if elapsed > budgetHealth {
		t.Fatalf("com o banco travado o handler levou %v, acima do orçamento de %v — o /health não pode ter prazo indefinido", elapsed, budgetHealth)
	}
	if code != http.StatusServiceUnavailable {
		t.Fatalf("com banco travado o /health tem de ser 503, veio %d (%v)", code, body)
	}
	if body["status"] != "degraded" {
		t.Errorf("status esperado \"degraded\", veio %q", body["status"])
	}
	msg, _ := body["databaseError"].(string)
	if msg == "" {
		t.Error("503 por banco travado tem de explicar a causa em databaseError")
	}
	// O texto precisa distinguir "trava" de "recusado": a providência é outra.
	if !strings.Contains(msg, "sem responder") {
		t.Errorf("databaseError %q não distingue banco travado de banco recusado", msg)
	}
	if body["databaseLastOkSeconds"] == nil {
		t.Error("databaseLastOkSeconds deveria dizer há quanto foi o último ping bom, mesmo no 503")
	}
}

// --- caso 4: o travamento não vira vazamento nem exaustão de pool -----------

// O handler responde sempre no prazo mesmo martelado, e o fundo para de
// acumular perguntas presas. Sem o teto, cada sondagem deixaria uma goroutine e
// uma conexão do pool presas para sempre — e em ~75s de banco travado o
// /health esgotaria as 25 conexões do pool e levaria junto o dispatcher do
// outbox, que é justamente o que este endpoint existe para proteger.
func TestHandleHealthBancoTravadoNaoAcumulaNemDrenaPool(t *testing.T) {
	fake := novoPingerPreso()
	s := novoServerDeTeste(fake)
	s.health = novoProbeCurto(fake, 20*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.health.run(ctx)

	esperaProbe(t, s, func() bool { return !s.health.check().ok }, "o /health continuou 200 com o banco travado")

	// Martela o endpoint como o healthcheck do Docker faria (a cada 3s), mas
	// bem mais rápido, e confirma que nenhuma resposta passa do orçamento.
	for i := 0; i < 60; i++ {
		code, _, elapsed := chamaHealth(t, s)
		if elapsed > budgetHealth {
			t.Fatalf("sonda %d levou %v, acima do orçamento de %v", i, elapsed, budgetHealth)
		}
		if code != http.StatusServiceUnavailable {
			t.Fatalf("sonda %d: esperado 503 com o banco travado, veio %d", i, code)
		}
	}

	// O teto segura: as tentativas presas são bounded, e uma fração pequena
	// das 60 sondas. Lê por `check` (que toma o mutex) porque o fundo escreve
	// nesse campo concorrentemente.
	presas := s.health.check().inFlight
	if presas > s.health.maxInFlight {
		t.Errorf("tentativas presas %d, acima do teto %d — o fundo está acumulando", presas, s.health.maxInFlight)
	}
	if presas == 0 {
		t.Error("esperava ao menos uma tentativa presa (o pinger não devolve)")
	}
	// E o número de pingsPedidos não cresce com o número de sondas do
	// handler: é o fundo que dita a cadência, não quem aperta o endpoint.
	if total := int(fake.calls.Load()); total > 10 {
		t.Errorf("o ping foi chamado %d vezes em ~1s de sondagem — o handler está tocando o banco", total)
	}
}

// --- caso 5: recuperação ----------------------------------------------------

// O travamento tem de ser reversível sem reiniciar o processo: destravar o banco
// devolve o 200. Este é o teste que impede o endpoint de ficar preso em 503.
func TestHandleHealthRecuperaDepoisQueOBancoVolta(t *testing.T) {
	fake := novoPingerPreso()
	s := novoServerDeTeste(fake)
	s.health = novoProbeCurto(fake, 30*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.health.run(ctx)

	esperaProbe(t, s, func() bool { return !s.health.check().ok }, "o /health continuou 200 com o banco travado")
	if code, _, _ := chamaHealth(t, s); code != http.StatusServiceUnavailable {
		t.Fatalf("pré-condição: esperava 503 com o banco travado, veio %d", code)
	}

	// Destrava: o pinger volta a responder, como um Postgres que sai do
	// `docker pause`.
	fake.destrava()

	esperaProbe(t, s, func() bool { return s.health.check().ok },
		"o /health não voltou a 200 depois que o banco destravou")

	code, body, elapsed := chamaHealth(t, s)
	if code != http.StatusOK {
		t.Fatalf("após destravar o /health tem de ser 200, veio %d (%v)", code, body)
	}
	if _, tem := body["databaseError"]; tem {
		t.Errorf("não deve haver databaseError depois de recuperar, veio %q", body["databaseError"])
	}
	if elapsed > budgetHealth {
		t.Errorf("respondeu em %v, acima do orçamento de %v", elapsed, budgetHealth)
	}
}

// --- caso 6: sem banco configurado -----------------------------------------

// Modo de rollback: sem DATABASE_URL o gateway sobe de propósito sem probe, e
// o /health é 200 com outboxEnabled:false. Não pode virar 503.
func TestHandleHealthSemBancoNaoFalaDeBanco(t *testing.T) {
	s := novoServerDeTeste(&pingerFake{})
	s.health = nil // main só cria o probe junto com o pool

	code, body, elapsed := chamaHealth(t, s)
	if code != http.StatusOK {
		t.Fatalf("sem DATABASE_URL o /health tem de ser 200, veio %d (%v)", code, body)
	}
	if body["outboxEnabled"] != false {
		t.Errorf("outboxEnabled deveria ser false sem pool, veio %v", body["outboxEnabled"])
	}
	if _, tem := body["databaseError"]; tem {
		t.Errorf("sem banco não há por que falar de databaseError, veio %q", body["databaseError"])
	}
	if _, tem := body["databaseLastOkSeconds"]; tem {
		t.Error("sem banco não há por que falar de databaseLastOkSeconds")
	}
	if elapsed > budgetHealth {
		t.Errorf("respondeu em %v, acima do orçamento de %v", elapsed, budgetHealth)
	}
}

// --- caso 6b: `outboxEnabled` é pool E gate --------------------------------

// envDispatch é o nome da flag do dispatcher. Ela mora no internal/outbox
// (gate.go) como `dispatchEnv`, sem exportação: aqui o nome é reescrito de
// propósito, porque o que se está testando é o contrato visto de FORA — é o
// nome que o operador digita no compose, e um teste que usasse a constante de
// outro pacote passaria mesmo se o nome tivesse mudado.
const envDispatch = "WS_DISPATCH"

// O gate `WS_DISPATCH` decide se o dispatcher publica; o /health precisa dizer a
// mesma coisa. Antes deste gate entrar no `outboxEnabled`, o campo era só
// "existe pool", que é verdade também no caso perigoso: o default é gate
// desligado, o healthcheck ficava verde e nenhum evento saía — gateway de pé,
// banco respondendo, silêncio. Cada linha desta tabela é um estado que o
// operador encontra em produção.
//
// O `200` com o gate desligado é decisão, não acidente: gate desligado é o modo
// de subida lado a lado (o dono do /realtime é o Node), e degradar esse estado
// derrubaria o `docker compose --profile ws-gateway` e o plano de rollback.
func TestOutboxEnabledRefletePoolEGate(t *testing.T) {
	casos := []struct {
		nome    string
		gate    string
		comPool bool
		quer    bool
	}{
		{"pool sem gate (o default em produção)", "", true, false},
		{"pool com gate desligado explicitamente", "0", true, false},
		{"pool com gate digitado errado", "sim", true, false},
		{"pool com gate ligado", "1", true, true},
		{"sem pool e sem gate (rollback)", "", false, false},
		{"sem pool mesmo com o gate ligado", "1", false, false},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			t.Setenv(envDispatch, c.gate)

			s := novoServerDeTeste(&pingerFake{})
			if !c.comPool {
				s.health = nil // main só cria o probe junto com o pool
			}

			code, body, _ := chamaHealth(t, s)
			if body["outboxEnabled"] != c.quer {
				t.Errorf("%s=%q, pool=%v: outboxEnabled = %v, quer %v",
					envDispatch, c.gate, c.comPool, body["outboxEnabled"], c.quer)
			}
			if code != http.StatusOK {
				t.Errorf("o gate não pode virar 503: code = %d (%v)", code, body)
			}
		})
	}
}

// --- caso 7: probe com prazo que o driver ignora não vira 200 mentindo ----

// Guarda direta da regra "nunca 200 mentindo": um "ok" envelhecido é sempre
// 503, independente do que o driver esteja fazendo.
func TestCheckNuncaAceitaOkEnvelhecido(t *testing.T) {
	fake := &pingerFake{} // banco quebrado
	fake.setErr(errors.New("banco fora"))
	s := novoServerDeTeste(fake)
	s.health = novoProbeCurto(fake, 10*time.Millisecond)

	// Um ok recente: vale.
	s.health.st.ok = true
	s.health.st.lastOK = time.Now()
	if v := s.health.check(); !v.ok {
		t.Fatal("um ping bom de agora há pouco tem de valer como ok")
	}

	// O mesmo ok, envelhecido: não vale mais, mesmo sem nenhum erro novo.
	s.health.st.lastOK = time.Now().Add(-11 * time.Millisecond)
	v := s.health.check()
	if v.ok {
		t.Fatal("um \"ok\" mais velho que o prazo tem de virar degraded")
	}
	if v.lastOKAge <= 0 {
		t.Error("a idade do último ok tem de ser reportada mesmo no 503")
	}
}

// --- correção 3: o pool é fechado no shutdown -------------------------------

// connectorFake é um `driver.Connector` que não fala com banco nenhum. Serve
// para testar o fechamento do pool sem subir Postgres, porque o que fechaPool
// precisa provar é que o `Close` chega no pool — e o `database/sql` chega nele
// pelo `Close` do connector (só chama se o connector for um `io.Closer`, ver
// sql.DB.Close).
type connectorFake struct {
	fechados atomic.Int64
	preso    chan struct{} // nil = o Close volta na hora; não-nil = só volta com `libera`
}

func (c *connectorFake) Connect(context.Context) (driver.Conn, error) {
	return connFake{}, nil
}
func (c *connectorFake) Driver() driver.Driver { return nil } // Close não usa

// Close conta e, se estiver preso, espera. É o simulado do que o driver de
// verdade faz com um banco congelado: escrever oBye no socket sem prazo. É
// exatamente por isso que a espera do shutdown tem teto.
func (c *connectorFake) Close() error {
	c.fechados.Add(1)
	if c.preso != nil {
		<-c.preso
	}
	return nil
}

type connFake struct{}

func (connFake) Prepare(string) (driver.Stmt, error) { return nil, errors.New("não implementado") }
func (connFake) Close() error                        { return nil }
func (connFake) Begin() (driver.Tx, error)           { return nil, errors.New("não implementado") }
func (connFake) Ping(context.Context) error          { return nil }

// O `Close` do pool é chamado: é o que o comentário da linha de shutdown
// promete, e promessa de Close não verificada é como um `defer pool.Close()`
// que ninguém notou que não existe.
func TestFechaPoolFechaOPool(t *testing.T) {
	conn := &connectorFake{}
	pool := sql.OpenDB(conn)
	fechaPool(pool, time.Second)

	if n := conn.fechados.Load(); n != 1 {
		t.Errorf("o Close do pool chamou %d vez(es) o Close do driver, quer 1 — a conexão não foi devolvida", n)
	}
	// Fechar de novo tem de ser inofensivo: o shutdown pode ser reentrado, e
	// `sql.DB.Close` é idempotente, então o driver não pode ver a segunda.
	fechaPool(pool, time.Second)
	if n := conn.fechados.Load(); n != 1 {
		t.Errorf("fechar o pool duas vezes chamou o driver %d vez(es), quer 1", n)
	}
}

// Sem DATABASE_URL — ou com o Connect falhando — não existe pool, e o shutdown
// não pode inventar um nem entrar em espera nenhuma.
func TestFechaPoolSemPoolNaoFazNada(t *testing.T) {
	inicio := time.Now()
	fechaPool(nil, time.Minute) // esperar aqui seria o bug
	if decorrido := time.Since(inicio); decorrido > time.Second {
		t.Errorf("fechaPool(nil) esperou %v: o caminho sem banco tem de ser imediato", decorrido)
	}
}

// Um banco congelado não pode pendurar o shutdown: o teto existe para isso.
// Aqui o que trava é o `Close` do driver — o ponto em que o lib/pq escreve no
// socket de um banco parado —, que é exatamente onde um `defer pool.Close()`
// sem teto prenderia o processo até o Docker mandar SIGKILL.
func TestFechaPoolNaoPenduraComOClosePreso(t *testing.T) {
	preso := make(chan struct{})
	libera := make(chan struct{})
	t.Cleanup(func() { close(libera) }) // a goroutine do Close não fica presa no fim do teste

	conn := &connectorFake{preso: preso}
	pool := sql.OpenDB(conn)

	teto := 50 * time.Millisecond
	inicio := time.Now()
	fechaPool(pool, teto)
	decorrido := time.Since(inicio)

	if decorrido < teto {
		t.Errorf("voltou em %v, antes do teto de %v: o Close preso não foi esperado", decorrido, teto)
	}
	if decorrido > 10*teto {
		t.Errorf("voltou em %v com o Close preso, muito acima do teto de %v — o shutdown ficou pendurado", decorrido, teto)
	}
	if conn.fechados.Load() == 0 {
		t.Error("o Close do driver nem foi chamado antes do teto")
	}
}

// --- helpers ---------------------------------------------------------------

// esperaProbe dá prazo para a condição virar verdadeira e falha o teste se
// não virar.
func esperaProbe(t *testing.T, s *server, d func() bool, msg string) {
	t.Helper()
	limite := time.Now().Add(2 * time.Second)
	for time.Now().Before(limite) {
		if d() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("%s", msg)
}
