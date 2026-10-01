package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// hardeningDaemon monta um Daemon com banco real, templates embutidos e uma
// impressora TCP "kitchen" apontando para address.
func hardeningDaemon(t *testing.T, address string, retry RetryConfig) *Daemon {
	t.Helper()
	d := newTestDaemon(t, Config{
		TemplatesDir: filepath.Join(t.TempDir(), "sem-templates"),
		Retry:        retry,
		Printers: map[string]PrinterProfile{
			"kitchen": {Address: address, Template: "kitchen-default"},
		},
	})
	if err := d.loadTemplates(); err != nil {
		t.Fatalf("loadTemplates: %v", err)
	}
	return d
}

func enqueueTestJob(t *testing.T, d *Daemon) string {
	t.Helper()
	template, err := d.templateFor("kitchen-default", "kitchen")
	if err != nil {
		t.Fatal(err)
	}
	req := PrintRequest{JobID: "job-1", OrderID: "order-1", Destination: "kitchen"}
	req.Order.Number = "#1"
	req.Order.Items = []Item{{Name: "Pão de queijo", Quantity: 2}}
	payload, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	if _, _, err := d.enqueue(req, template, payload, hash); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	return req.JobID
}

// fakePrinter aceita conexões TCP, conta quantas chegaram e entrega os bytes
// de cada uma. Simula uma impressora de rede na porta 9100.
type fakePrinter struct {
	addr     string
	conns    int32
	received chan []byte
}

func startFakePrinter(t *testing.T) *fakePrinter {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fp := &fakePrinter{addr: ln.Addr().String(), received: make(chan []byte, 16)}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			atomic.AddInt32(&fp.conns, 1)
			go func() {
				defer conn.Close()
				data, _ := io.ReadAll(conn)
				fp.received <- data
			}()
		}
	}()
	return fp
}

// ---------------------------------------------------------------------
// Claim atômico, recuperação e impressão única
// ---------------------------------------------------------------------

func TestClaimJobEhAtomico(t *testing.T) {
	d := hardeningDaemon(t, "127.0.0.1:1", RetryConfig{})
	id := enqueueTestJob(t, d)

	var wins int32
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, claimed, err := d.claimJob(id)
			if err != nil {
				t.Errorf("claimJob: %v", err)
				return
			}
			if claimed {
				atomic.AddInt32(&wins, 1)
			}
		}()
	}
	wg.Wait()

	if wins != 1 {
		t.Fatalf("%d goroutines reservaram o mesmo job; só uma pode", wins)
	}
	if got := d.jobStatus(id); got != "printing" {
		t.Fatalf("status = %q, quero printing", got)
	}
}

func TestProcessConcorrenteImprimeUmaVez(t *testing.T) {
	printer := startFakePrinter(t)
	d := hardeningDaemon(t, printer.addr, RetryConfig{MaxAttempts: 3, BaseDelaySecs: 1, MaxDelaySecs: 1})
	id := enqueueTestJob(t, d)

	// O mesmo job chega por três caminhos ao mesmo tempo: HTTP, nuvem e retry
	// worker. Só um pode imprimir.
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = d.process(id)
		}()
	}
	wg.Wait()

	var data []byte
	select {
	case data = <-printer.received:
	case <-time.After(3 * time.Second):
		t.Fatal("a impressora não recebeu nada")
	}
	time.Sleep(150 * time.Millisecond) // dá tempo a uma segunda conexão indevida
	if n := atomic.LoadInt32(&printer.conns); n != 1 {
		t.Fatalf("a impressora recebeu %d conexões; o cupom saiu duplicado", n)
	}
	if got := d.jobStatus(id); got != "sent_to_printer" {
		t.Fatalf("status = %q, quero sent_to_printer", got)
	}
	// Perfil sem encoding = cp850: ESC t 2 logo após o ESC @, e "ã" vira 0xC6.
	if !bytes.HasPrefix(data, []byte{0x1b, 0x40, 0x1b, 0x74, 0x02}) {
		t.Fatalf("cupom não começa com ESC @ ESC t 2: % x", data[:min(len(data), 8)])
	}
	if !bytes.Contains(data, []byte("2x P\xc6o de queijo")) {
		t.Fatalf("item não saiu em CP850: %q", data)
	}
}

func TestRecoverInterruptedJobs(t *testing.T) {
	d := hardeningDaemon(t, "127.0.0.1:1", RetryConfig{})
	id := enqueueTestJob(t, d)
	if _, claimed, err := d.claimJob(id); err != nil || !claimed {
		t.Fatalf("claimJob: claimed=%v err=%v", claimed, err)
	}

	n, err := d.recoverInterruptedJobs()
	if err != nil || n != 1 {
		t.Fatalf("recoverInterruptedJobs = %d, %v; quero 1, nil", n, err)
	}
	if got := d.jobStatus(id); got != "reprint_confirmation" {
		t.Fatalf("status = %q, quero reprint_confirmation", got)
	}
	// Não pode ser reimpresso sozinho pelo retry worker.
	if _, claimed, _ := d.claimJob(id); claimed {
		t.Fatal("job em reprint_confirmation não deveria ser reservável")
	}
}

// ---------------------------------------------------------------------
// Retry genérico
// ---------------------------------------------------------------------

func TestRetryClassificacaoIndependeDoTransporte(t *testing.T) {
	base := errors.New("fila CUPS indisponível")
	if isRetryablePrinterError(base) {
		t.Fatal("erro comum não deveria ser repetido (pode ter impresso metade)")
	}
	if !isRetryablePrinterError(markTransient(base)) {
		t.Fatal("erro marcado como transitório deveria ser repetido")
	}
	if !isRetryablePrinterError(fmt.Errorf("contexto: %w", markTransient(base))) {
		t.Fatal("a marca precisa sobreviver a fmt.Errorf(%w)")
	}
	if markTransient(nil) != nil {
		t.Fatal("markTransient(nil) deve ser nil")
	}
}

func TestProcessRetryEDepoisFalhaSemPapelParcial(t *testing.T) {
	// Porta fechada: a conexão é recusada, nenhum byte sai.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	d := hardeningDaemon(t, addr, RetryConfig{MaxAttempts: 2, BaseDelaySecs: 1, MaxDelaySecs: 1})
	id := enqueueTestJob(t, d)

	if err := d.process(id); err == nil || !isRetryablePrinterError(err) {
		t.Fatalf("1ª tentativa: err = %v; quero erro transitório", err)
	}
	if got := d.jobStatus(id); got != "retry_waiting" {
		t.Fatalf("depois da 1ª tentativa status = %q, quero retry_waiting", got)
	}

	if err := d.process(id); err == nil {
		t.Fatal("2ª tentativa deveria falhar")
	}
	// Tentativas esgotadas sem nenhum byte enviado: 'failed', não
	// 'reprint_confirmation' (que sugeriria cupom impresso pela metade).
	if got := d.jobStatus(id); got != "failed" {
		t.Fatalf("depois de esgotar as tentativas status = %q, quero failed", got)
	}
}

func TestRenderComEncodingInvalidoFalhaSemEnviar(t *testing.T) {
	d := hardeningDaemon(t, "127.0.0.1:1", RetryConfig{})
	d.cfg.Printers["kitchen"] = PrinterProfile{Address: "127.0.0.1:1", Template: "kitchen-default", Encoding: "klingon"}
	id := enqueueTestJob(t, d)
	if err := d.process(id); err == nil {
		t.Fatal("encoding desconhecido deveria falhar")
	}
	if got := d.jobStatus(id); got != "failed" {
		t.Fatalf("status = %q, quero failed", got)
	}
}

// ---------------------------------------------------------------------
// Codificação e sanitização
// ---------------------------------------------------------------------

func TestEncodeCP850(t *testing.T) {
	enc, err := encoderFor(PrinterProfile{})
	if err != nil || enc == nil {
		t.Fatalf("encoderFor vazio = %v, %v; quero cp850", enc, err)
	}
	if enc.codePage != 2 {
		t.Fatalf("code page padrão = %d, quero 2 (PC850)", enc.codePage)
	}
	got := enc.encode("ÇçÃãÕõÁáÉéÍíÓóÚúÂâÊêÔôÀà")
	want := []byte{0x80, 0x87, 0xC7, 0xC6, 0xE5, 0xE4, 0xB5, 0xA0, 0x90, 0x82, 0xD6, 0xA1, 0xE0, 0xA2, 0xE9, 0xA3, 0xB6, 0x83, 0xD2, 0x88, 0xE2, 0x93, 0xB7, 0x85}
	if !bytes.Equal(got, want) {
		t.Fatalf("cp850 = % x\nquero    % x", got, want)
	}
}

func TestEncodeTabelasTemTodosOs128Bytes(t *testing.T) {
	for name, high := range map[string]string{"cp850": cp850High, "cp858": cp858High, "cp1252": cp1252High} {
		if n := len([]rune(high)); n != 128 {
			t.Fatalf("%s tem %d posições, quero 128", name, n)
		}
	}
}

func TestEncodeOutrasCodePages(t *testing.T) {
	win, err := encoderFor(PrinterProfile{Encoding: "windows-1252"})
	if err != nil {
		t.Fatal(err)
	}
	if got := win.encode("Çã€"); !bytes.Equal(got, []byte{0xC7, 0xE3, 0x80}) {
		t.Fatalf("windows-1252 = % x", got)
	}
	if win.codePage != 16 {
		t.Fatalf("code page windows-1252 = %d, quero 16", win.codePage)
	}

	cp858, err := encoderFor(PrinterProfile{Encoding: "CP858"})
	if err != nil {
		t.Fatal(err)
	}
	if got := cp858.encode("€"); !bytes.Equal(got, []byte{0xD5}) {
		t.Fatalf("cp858 € = % x, quero d5", got)
	}
}

func TestEncodeFallbackEDesconhecidos(t *testing.T) {
	enc, _ := encoderFor(PrinterProfile{})
	if got := string(enc.encode("a–b “x”")); got != `a-b "x"` {
		t.Fatalf("fallback ASCII = %q", got)
	}
	if got := string(enc.encode("日")); got != "?" {
		t.Fatalf("caractere sem equivalente = %q, quero ?", got)
	}
}

func TestEncoderForConfiguracao(t *testing.T) {
	if enc, err := encoderFor(PrinterProfile{Encoding: "utf-8"}); enc != nil || err != nil {
		t.Fatalf("utf-8 deve desligar a conversão: %v, %v", enc, err)
	}
	if _, err := encoderFor(PrinterProfile{Encoding: "klingon"}); err == nil {
		t.Fatal("encoding desconhecido deveria dar erro")
	}
	page := 19
	enc, err := encoderFor(PrinterProfile{Encoding: "cp850", CodePage: &page})
	if err != nil || enc.codePage != 19 {
		t.Fatalf("code_page não sobrescreveu ESC t: %v, %v", enc, err)
	}
	bad := 300
	if _, err := encoderFor(PrinterProfile{CodePage: &bad}); err == nil {
		t.Fatal("code_page fora de 0-255 deveria dar erro")
	}
}

func TestSanitizeText(t *testing.T) {
	if got := sanitizeText("A\x1dV\x00B\r\tC\nD\x7f"); got != "AVB C\nD" {
		t.Fatalf("sanitizeText = %q", got)
	}
}

func TestRenderNaoExecutaComandosVindosDoPedido(t *testing.T) {
	tpl := Template{Columns: 48, Blocks: []Block{{Type: "text", Value: "X\x1d\x56\x00Y\x1b\x70\x00Z"}}}
	for _, enc := range []*encoder{nil, mustEncoder(t, PrinterProfile{})} {
		out, err := renderWith(tpl, Order{}, enc)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(out, []byte{0x1d, 0x56}) || bytes.Contains(out, []byte{0x1b, 0x70}) {
			t.Fatalf("comando ESC/POS do pedido chegou à impressora: % x", out)
		}
		// Só os bytes de controle somem; as letras V e p (0x56, 0x70) ficam.
		if !bytes.Contains(out, []byte("XVYpZ")) {
			t.Fatalf("texto esperado XVYpZ não encontrado: %q", out)
		}
	}
}

func TestRenderWithCP850BytesExatos(t *testing.T) {
	tpl := Template{Columns: 48, Blocks: []Block{{Type: "text", Value: "AÇÃO"}}}
	got, err := renderWith(tpl, Order{}, mustEncoder(t, PrinterProfile{}))
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{
		0x1b, 0x40, // ESC @
		0x1b, 0x74, 0x02, // ESC t 2 (PC850)
		0x1b, 0x61, 0x00, // alinhar à esquerda
		0x1b, 0x45, 0x00, // negrito off
		0x1d, 0x21, 0x00, // tamanho normal
		0x41, 0x80, 0xc7, 0x4f, 0x0a, // "AÇÃO\n" em CP850
		0x1d, 0x21, 0x00,
		0x1b, 0x45, 0x00,
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("bytes divergem\n got % x\nwant % x", got, want)
	}
}

func TestRenderForProfileUTF8EquivaleAoRenderLogico(t *testing.T) {
	order := fixtureOrder(t)
	for _, tc := range goldenCases(t) {
		logical, err := render(tc.template, order)
		if err != nil {
			t.Fatal(err)
		}
		viaProfile, err := renderForProfile(tc.template, order, PrinterProfile{Encoding: "utf-8"})
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(logical, viaProfile) {
			t.Fatalf("%s: encoding utf-8 deveria ser idêntico ao render() do golden", tc.nome)
		}
	}
}

func mustEncoder(t *testing.T, profile PrinterProfile) *encoder {
	t.Helper()
	enc, err := encoderFor(profile)
	if err != nil || enc == nil {
		t.Fatalf("encoderFor: %v, %v", enc, err)
	}
	return enc
}

// ---------------------------------------------------------------------
// CORS / Origin e token
// ---------------------------------------------------------------------

func TestCORSRecusaOrigemDesconhecidaInclusiveEmPostSimples(t *testing.T) {
	called := false
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}), allowedOrigins(Config{}))

	// POST "simples" de um site qualquer: text/plain dispensa preflight, então
	// só o CORS não impediria a impressão.
	req := httptest.NewRequest(http.MethodPost, "/api/print", nil)
	req.Header.Set("Origin", "https://site-malvado.example")
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || called {
		t.Fatalf("origem desconhecida: code=%d handlerChamado=%v; quero 403 e handler não chamado", rec.Code, called)
	}

	// Sem Origin (curl, Rust/Tauri): segue normalmente.
	req = httptest.NewRequest(http.MethodPost, "/api/print", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !called {
		t.Fatalf("cliente sem Origin foi bloqueado: code=%d", rec.Code)
	}
}

func TestCORSPreflightLiberaAuthorization(t *testing.T) {
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("o preflight não deve chegar ao handler")
	}), allowedOrigins(Config{AllowedOrigins: []string{"https://pdv.exemplo.com"}}))

	req := httptest.NewRequest(http.MethodOptions, "/api/v1/print", nil)
	req.Header.Set("Origin", "https://pdv.exemplo.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight = %d, quero 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "Content-Type, Authorization" {
		t.Fatalf("Allow-Headers = %q; sem Authorization o navegador bloqueia clientes com token", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://pdv.exemplo.com" {
		t.Fatalf("Allow-Origin = %q", got)
	}
	if rec.Header().Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatal("faltou Access-Control-Allow-Private-Network no preflight de rede local")
	}
}

func TestAuthorizeComToken(t *testing.T) {
	d := &Daemon{cfg: Config{APIToken: "segredo"}}

	rec := httptest.NewRecorder()
	if d.authorize(rec, httptest.NewRequest(http.MethodGet, "/api/jobs", nil)) || rec.Code != http.StatusUnauthorized {
		t.Fatalf("sem token: code=%d, quero 401", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	req.Header.Set("Authorization", "Bearer errado")
	rec = httptest.NewRecorder()
	if d.authorize(rec, req) {
		t.Fatal("token errado foi aceito")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	req.Header.Set("Authorization", "Bearer segredo")
	if !d.authorize(httptest.NewRecorder(), req) {
		t.Fatal("token correto foi recusado")
	}
}

func TestEnsureConfigGeraTokenNaPrimeiraExecucao(t *testing.T) {
	path := filepath.Join(t.TempDir(), "PDV Printer", "config.json")
	cfg, err := ensureConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.APIToken) != 64 {
		t.Fatalf("api_token com %d caracteres, quero 64 (256 bits em hex)", len(cfg.APIToken))
	}
	reloaded, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.APIToken != cfg.APIToken {
		t.Fatal("o token em memória difere do gravado: o cliente usaria um token que o restart não reconhece")
	}
	if other := newAPIToken(); other == cfg.APIToken {
		t.Fatal("newAPIToken repetiu o valor")
	}
}
