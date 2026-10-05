package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pdv-pagarme-webhook/internal/charge"
	"pdv-pagarme-webhook/internal/inbox"
)

// =============================================================================
// Suíte do HTTP.
//
// O servidor de verdade (`httptest.NewServer`) contra as rotas de verdade, e não
// `handler.ServeHTTP` com um `ResponseRecorder`: o que está em jogo inclui o
// `http.MaxBytesReader` (que depende do `ResponseWriter` real para cortar a
// conexão), o método, o caminho e o status.
//
// A assinatura é calculada do lado do teste com `crypto/hmac` e não chamando o
// código sob teste — se usasse `signature.Verify`, o teste seria uma tautologia e
// passaria verde com as duas pontas quebradas.
// =============================================================================

const secretKey = "sk_test_segredo"

// -----------------------------------------------------------------------------
// doubles
// -----------------------------------------------------------------------------

// fakeStore é a inbox em miniatura. `falha` decide o que o `Record` devolve, e
// `viuCorpoCruto` guarda os bytes que chegaram — é o que prova que o corpo CRU
// vai para o banco e não uma re-serialização.
type fakeStore struct {
	mu         sync.Mutex
	chamadas   int
	viuCorpo   []byte
	viuPayload *charge.WebhookPayload
	respostaID string
	isNew      bool
	falha      error
}

func (f *fakeStore) Record(_ context.Context, rawBody []byte, payload *charge.WebhookPayload) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chamadas++
	f.viuCorpo = append([]byte(nil), rawBody...)
	f.viuPayload = payload
	if f.falha != nil {
		return "", false, f.falha
	}
	id := f.respostaID
	if id == "" {
		id = "linha-uuid"
	}
	return id, f.isNew, nil
}

func (f *fakeStore) estado() (chamadas int, corpo []byte, payload *charge.WebhookPayload) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.chamadas, append([]byte(nil), f.viuCorpo...), f.viuPayload
}

// pingerFalso devolve o erro que o teste quiser, ou nil.
type pingerFalso struct {
	mu       sync.Mutex
	chamadas int32
	err      error
	atraso   time.Duration
}

func (p *pingerFalso) PingContext(ctx context.Context) error {
	atomic.AddInt32(&p.chamadas, 1)
	if p.atraso > 0 {
		// Ignora o prazo do contexto de propósito: é o que o lib/pq faz contra
		// um servidor congelado, e é o defeito que o probe de fundo contorna.
		select {
		case <-time.After(p.atraso):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return p.err
}

func (p *pingerFalso) setErr(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.err = err
}

// pingerPreso nunca volta e IGNORA o prazo do contexto.
//
// É o que o lib/pq faz contra um servidor congelado: o `PingContext` não cancela a
// query já despachada, porque o cancelamento é entregue numa conexão TCP nova, e
// contra um banco travado essa conexão trava tanto quanto a original. Sem um
// duplo assim, o teste do teto de perguntas em andamento não mede nada — um
// pinger que respeita o deadline volta sozinho e a conexão nunca fica presa.
type pingerPreso struct {
	chamadas int32
	presos   int32
	solta    chan struct{}
}

func (p *pingerPreso) PingContext(context.Context) error {
	atomic.AddInt32(&p.chamadas, 1)
	atomic.AddInt32(&p.presos, 1)
	<-p.solta // ignora o ctx de propósito
	atomic.AddInt32(&p.presos, -1)
	return nil
}

func (p *pingerPreso) destrava() {
	select {
	case <-p.solta:
	default:
		close(p.solta)
	}
}

// pingerMutavel começa respondendo e pode CONGELAR e DESTRAVAR, que é a sequência
// que o banco real faz num deploy: some por uns segundos (deploy, failover) e
// volta sozinho.
type pingerMutavel struct {
	mu        sync.Mutex
	congelado bool
	solta     chan struct{}
	chamadas  int32
}

func novoPingerMutavel() *pingerMutavel {
	return &pingerMutavel{solta: make(chan struct{})}
}

func (p *pingerMutavel) PingContext(ctx context.Context) error {
	atomic.AddInt32(&p.chamadas, 1)
	p.mu.Lock()
	if p.congelado {
		solta := p.solta
		p.mu.Unlock()
		// Espera sem olhar o ctx: é o comportamento do driver contra um servidor
		// congelado, e é o defeito que o probe de fundo contorna.
		select {
		case <-solta:
		case <-ctx.Done():
			return ctx.Err()
		}
		return nil
	}
	p.mu.Unlock()
	return nil
}

func (p *pingerMutavel) congela() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.congelado = true
}

func (p *pingerMutavel) destrava() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.congelado {
		close(p.solta)
		p.solta = make(chan struct{})
	}
	p.congelado = false
}

// -----------------------------------------------------------------------------
// utilidades
// -----------------------------------------------------------------------------

// assina calcula a HMAC-SHA1 do corpo, do jeito que o Pagar.me calcula.
func assina(body []byte) string {
	mac := hmac.New(sha1.New, []byte(secretKey))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// novoServer sobe um servidor real com o mux do serviço.
func novoServer(t *testing.T, store *fakeStore, secret string, health *HealthProbe) (*httptest.Server, *Client) {
	t.Helper()
	s := New(secret, store, health, "teste")
	srv := httptest.NewServer(s.Rotas())
	t.Cleanup(srv.Close)
	return srv, &Client{base: srv.URL}
}

// Client faz as requisições, com a assinatura pronta.
type Client struct {
	base string
}

func (c *Client) post(t *testing.T, path, body, signature string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, c.base+path, strings.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest falhou: %v", err)
	}
	if signature != "" {
		req.Header.Set("X-Hub-Signature", signature)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("requisição falhou: %v", err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

// postAssinado envia o corpo já assinado — o caminho feliz.
func (c *Client) postAssinado(t *testing.T, path, body string) *http.Response {
	t.Helper()
	return c.post(t, path, body, assina([]byte(body)))
}

func corpo(t *testing.T, res *http.Response) map[string]any {
	t.Helper()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("leitura do corpo falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("resposta não é JSON: %v (%s)", err, raw)
	}
	return m
}

func erroDe(t *testing.T, res *http.Response) string {
	t.Helper()
	m := corpo(t, res)
	e, ok := m["error"].(map[string]any)
	if !ok {
		t.Fatalf("resposta sem envelope de erro: %v", m)
	}
	c, _ := e["code"].(string)
	return c
}

func calaLog(t *testing.T) {
	t.Helper()
	original := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(original) })
}

func probeSaudavel() *HealthProbe {
	// NewHealthProbe com um pinger que responde ok: `Conectado()` é true e o
	// primeiro `Check()` devolve ok porque `connectedAt` é semeado como último ok.
	return NewHealthProbe(&pingerFalso{}, time.Now())
}

// -----------------------------------------------------------------------------
// 503 sem credencial
// -----------------------------------------------------------------------------

// Sem `PAGARME_SECRET_KEY` não há como validar assinatura, e o 503 é a única
// resposta aceitável. Um 200 aqui deixaria qualquer pessoa que descobrisse a URL
// marcar cobrança como paga — e a reconciliação depois trataria esse "pago"
// inventado como verdade do gateway, porque relê o gateway e o gateway não sabe
// de nada.
func TestWebhookSemSecretKeyDevolve503(t *testing.T) {
	store := &fakeStore{isNew: true}
	_, c := novoServer(t, store, "", probeSaudavel())
	calaLog(t)

	body := `{"id":"evt_1","type":"order.paid","data":{"id":"or_1"}}`
	res := c.postAssinado(t, "/webhooks/pagarme", body)

	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, quer 503 (sem credencial)", res.StatusCode)
	}
	if codigo := erroDe(t, res); codigo != "pagarme_not_configured" {
		t.Errorf("error.code = %q, quer pagarme_not_configured", codigo)
	}
	// E nada foi gravado: um 200 aqui gravaria o evento.
	if chamadas, _, _ := store.estado(); chamadas != 0 {
		t.Errorf("o inbox foi chamado %d vez(es) sem credencial", chamadas)
	}
}

// Mesmo com o corpo inválido: o 503 vem ANTES de qualquer parse. Sem
// credencial não se olha o payload de ninguém.
func TestWebhookSemSecretKeyRecusaAntesDeParsear(t *testing.T) {
	store := &fakeStore{isNew: true}
	_, c := novoServer(t, store, "", probeSaudavel())
	calaLog(t)

	res := c.post(t, "/webhooks/pagarme", `isto não é json`, "")
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, quer 503 — a checagem de credencial vem antes do parse", res.StatusCode)
	}
}

// O `/health` também degrada sem credencial, porque este serviço recusa TODO
// webhook nesse estado. Um 200 aqui faria o Caddy apontar o tráfego para um
// serviço que responde 503 em cada requisição.
func TestHealthDegradaSemSecretKey(t *testing.T) {
	srv, _ := novoServer(t, &fakeStore{}, "", probeSaudavel())
	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health falhou: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, quer 503 sem credencial", res.StatusCode)
	}
	m := corpo(t, res)
	if m["status"] != "degraded" {
		t.Errorf("status = %v, quer degraded", m["status"])
	}
	if m["secretKeyError"] == nil {
		t.Error("secretKeyError ausente: o 503 precisa dizer POR QUÊ")
	}
	if m["webhookEnabled"] != false {
		t.Errorf("webhookEnabled = %v, quer false", m["webhookEnabled"])
	}
}

// -----------------------------------------------------------------------------
// 401 assinatura inválida
// -----------------------------------------------------------------------------

func TestWebhookAssinaturaInvalidaDevolve401(t *testing.T) {
	body := `{"id":"evt_1","type":"order.paid","data":{"id":"or_1"}}`
	casos := []struct {
		nome      string
		signature string
	}{
		{"ausente", ""},
		{"correta mas de outro corpo", assina([]byte(`{"id":"outro"}`))},
		{"prefixo de outro algoritmo", "sha256=" + assina([]byte(body))},
		{"hex inválido", "nao-e-hex"},
		{"truncada", assina([]byte(body))[:39]},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			store := &fakeStore{isNew: true}
			_, cli := novoServer(t, store, secretKey, probeSaudavel())
			calaLog(t)

			res := cli.post(t, "/webhooks/pagarme", body, c.signature)
			if res.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, quer 401", res.StatusCode)
			}
			if codigo := erroDe(t, res); codigo != "invalid_signature" {
				t.Errorf("error.code = %q, quer invalid_signature", codigo)
			}
			if chamadas, _, _ := store.estado(); chamadas != 0 {
				t.Errorf("o inbox foi chamado %d vez(es) com assinatura inválida", chamadas)
			}
		})
	}
}

// A assinatura é conferida ANTES do parse, o que tem uma consequência observável:
// um corpo que NÃO é JSON com assinatura INVÁLIDA responde 401 (e não 400), porque
// a checagem de assinatura vem primeiro na ordem.
func TestWebhookAssinaturaInvalidaVenceSobreBodyInvalido(t *testing.T) {
	store := &fakeStore{isNew: true}
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	res := c.post(t, "/webhooks/pagarme", `isto não é json`, "sig-invalida")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, quer 401: a assinatura é conferida antes do parse", res.StatusCode)
	}
}

// -----------------------------------------------------------------------------
// 400 corpo não-JSON
// -----------------------------------------------------------------------------

func TestWebhookCorpoNaoJSONDevolve400(t *testing.T) {
	store := &fakeStore{isNew: true}
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	res := c.postAssinado(t, "/webhooks/pagarme", `isto não é json`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, quer 400", res.StatusCode)
	}
	if codigo := erroDe(t, res); codigo != "validation_failed" {
		t.Errorf("error.code = %q, quer validation_failed", codigo)
	}
	if chamadas, _, _ := store.estado(); chamadas != 0 {
		t.Errorf("o inbox foi chamado %d vez(es) com corpo inválido", chamadas)
	}
}

// Um corpo JSON válido mas que NÃO é objeto não pode virar evento.
func TestWebhookJSONQueNaoEObjetoDevolve400(t *testing.T) {
	for _, body := range []string{`[1,2,3]`, `"uma string"`, `42`, `null`, `true`} {
		store := &fakeStore{isNew: true}
		_, c := novoServer(t, store, secretKey, probeSaudavel())
		calaLog(t)

		res := c.postAssinado(t, "/webhooks/pagarme", body)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("corpo %s: status = %d, quer 400", body, res.StatusCode)
		}
	}
}

// Corpo não-UTF8 com assinatura VÁLIDA: 400, e não o 503 de "invalid byte
// sequence" do Postgres. O byte inválido passaria pelo `json.Unmarshal` do Go
// (que substitui por U+FFFD em vez de falhar) e estouraria no insert de uma coluna
// TEXT — com o Pagar.me reenviando para sempre.
func TestWebhookCorpoNaoUTF8Devolve400(t *testing.T) {
	store := &fakeStore{isNew: true}
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	// JSON com um byte 0xFF solto dentro de uma string: parseável pelo Go,
	// inválido como UTF-8.
	bruto := []byte("{\"id\":\"evt_\xff1\"}")
	res := c.post(t, "/webhooks/pagarme", string(bruto), assina(bruto))

	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, quer 400 (corpo não é UTF-8)", res.StatusCode)
	}
	if chamadas, _, _ := store.estado(); chamadas != 0 {
		t.Errorf("o inbox foi chamado com corpo não-UTF8: o Postgres teria recusado o byte")
	}
}

// Evento sem `id`: 400, não 503. Sem `event_id` não há como deduplicar, e
// deduplicar é o requisito — o evento nunca será gravado, então reenviar para
// sempre não resolve nada. (O Node responde 503 aqui; ver a divergência anotada.)
func TestWebhookSemEventIDDevolve400(t *testing.T) {
	store := &fakeStore{isNew: true, falha: inbox.ErrNoEventID}
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	res := c.postAssinado(t, "/webhooks/pagarme", `{"type":"order.paid","data":{"id":"or_1"}}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, quer 400 (evento sem id é permanente)", res.StatusCode)
	}
	if codigo := erroDe(t, res); codigo != "validation_failed" {
		t.Errorf("error.code = %q, quer validation_failed", codigo)
	}
}

// Falha de infraestrutura no insert: 503, que FAZ o Pagar.me reenviar — correto,
// porque "não consegui persistir" é diferente de "persisti e não achei
// correspondente".
func TestWebhookFalhaDeInfraestruturaDevolve503(t *testing.T) {
	store := &fakeStore{falha: errors.New("pq: connection refused")}
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	res := c.postAssinado(t, "/webhooks/pagarme", `{"id":"evt_1","data":{"id":"or_1"}}`)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, quer 503 (banco fora)", res.StatusCode)
	}
	if codigo := erroDe(t, res); codigo != "service_unavailable" {
		t.Errorf("error.code = %q, quer service_unavailable", codigo)
	}
}

// -----------------------------------------------------------------------------
// 200: evento novo e reenvio
// -----------------------------------------------------------------------------

// O caminho feliz inteiro: 200, o evento gravado, e o corpo CRU indo para a inbox
// byte a byte.
func TestWebhookEventoNovoDevolve200EGravaCorpoCrú(t *testing.T) {
	store := &fakeStore{isNew: true, respostaID: "linha-1"}
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	// Espaçamento e ordem de chave "estranhos" de propósito: o que vai para
	// `payload` tem que ser EXATAMENTE isto, não um objeto re-serializado.
	body := `{"type":"order.paid",  "id":"evt_1","data":{"amount":4590,"id":"or_1"}}`
	res := c.postAssinado(t, "/webhooks/pagarme", body)

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, quer 200", res.StatusCode)
	}
	m := corpo(t, res)
	if m["received"] != true {
		t.Errorf("received = %v, quer true", m["received"])
	}
	if m["duplicate"] != false {
		t.Errorf("duplicate = %v, quer false num evento novo", m["duplicate"])
	}

	chamadas, visto, payload := store.estado()
	if chamadas != 1 {
		t.Fatalf("o inbox foi chamado %d vez(es), quer 1", chamadas)
	}
	if string(visto) != body {
		t.Errorf("o payload gravado difere do corpo recebido:\n gravado=%s\n recebido=%s", visto, body)
	}
	if payload.ID != "evt_1" || payload.Type != "order.paid" {
		t.Errorf("payload parseado = %+v", payload)
	}
	if payload.Data == nil || payload.Data.ID != "or_1" {
		t.Errorf("payload.data não foi parseado: %+v", payload.Data)
	}
}

// O REENVIO é 200 e diz `duplicate: true`. É o caso que o Pagar.me provoca
// (reenvia enquanto não recebe 200), e devolver 4xx faria ele reenviar
// indefinidamente um evento já tratado.
func TestWebhookReenvioDevolve200ComDuplicate(t *testing.T) {
	store := &fakeStore{isNew: false} // o índice único já tem o evento
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	res := c.postAssinado(t, "/webhooks/pagarme", `{"id":"evt_1","data":{"id":"or_1"}}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, quer 200 no reenvio (4xx faz o Pagar.me reenviar para sempre)", res.StatusCode)
	}
	m := corpo(t, res)
	if m["received"] != true {
		t.Errorf("received = %v, quer true", m["received"])
	}
	if m["duplicate"] != true {
		t.Errorf("duplicate = %v, quer true no reenvio", m["duplicate"])
	}
}

// -----------------------------------------------------------------------------
// corpo grande demais
// -----------------------------------------------------------------------------

// O teto de 1 MiB. É um limite de recurso, não de negócio: o endpoint é
// alcançável da internet sem autenticação de sessão (a autenticação é a
// assinatura, conferida DEPOIS de ler o corpo), então um `POST` gigante alocaria
// memória antes de qualquer validação.
func TestWebhookCorpoAcimaDoTetoDevolve413(t *testing.T) {
	store := &fakeStore{isNew: true}
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	// JSON válido de >1 MiB. O campo `pad` existe só para crescer o corpo: o
	// `charge.WebhookPayload` ignora o que não conhece, e um webhook "real" com
	// um `items[]` enorme tem exatamente esta forma.
	corpoGrande := fmt.Sprintf(`{"id":"evt_grande","pad":%q}`, strings.Repeat("x", MaxBodyBytes+1024))

	res := c.postAssinado(t, "/webhooks/pagarme", corpoGrande)
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, quer 413 (corpo de %d bytes)", res.StatusCode, len(corpoGrande))
	}
	if chamadas, _, _ := store.estado(); chamadas != 0 {
		t.Errorf("o inbox foi chamado %d vez(es) com corpo acima do teto", chamadas)
	}
}

// Logo abaixo do teto é aceito — o limite não pode estar picando antes da hora.
func TestWebhookCorpoAlemDoTetoAindaEhAceito(t *testing.T) {
	store := &fakeStore{isNew: true}
	_, c := novoServer(t, store, secretKey, probeSaudavel())
	calaLog(t)

	body := fmt.Sprintf(`{"id":"evt_grande_ok","pad":%q}`, strings.Repeat("x", 64*1024))
	if len(body) >= MaxBodyBytes {
		t.Fatalf("o corpo de teste tem %d bytes e deveria caber no teto de %d", len(body), MaxBodyBytes)
	}

	res := c.postAssinado(t, "/webhooks/pagarme", body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, quer 200 com corpo de %d bytes", res.StatusCode, len(body))
	}
}

// -----------------------------------------------------------------------------
// método
// -----------------------------------------------------------------------------

// Um GET no endpoint existe e é recusado com 405, não com 401. Um 401 seria
// mentira: o endpoint existe, quem errou foi o método — e sem esta checagem o GET
// cairia no caminho de "corpo vazio" e responderia 401, que não significa nada.
func TestWebhookRecusaMetodoDiferenteDePOST(t *testing.T) {
	for _, metodo := range []string{http.MethodGet, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		store := &fakeStore{isNew: true}
		srv, _ := novoServer(t, store, secretKey, probeSaudavel())
		calaLog(t)

		req, _ := http.NewRequest(metodo, srv.URL+"/webhooks/pagarme", nil)
		req.Header.Set("X-Hub-Signature", assina([]byte("")))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s falhou: %v", metodo, err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()

		if res.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s: status = %d, quer 405 (%s)", metodo, res.StatusCode, body)
		}
		if got := res.Header.Get("Allow"); got != http.MethodPost {
			t.Errorf("%s: header Allow = %q, quer POST", metodo, got)
		}
		if chamadas, _, _ := store.estado(); chamadas != 0 {
			t.Errorf("%s: o inbox foi chamado", metodo)
		}
	}
}

// -----------------------------------------------------------------------------
// rotas
// -----------------------------------------------------------------------------

// Só existem duas rotas. Uma terceira (leitura de evento, reprocessamento de
// DLQ, qualquer coisa) significaria estado de domínio no Go — que é a linha que
// este serviço não pode atravessar.
func TestRotas(t *testing.T) {
	store := &fakeStore{isNew: true}
	s := New(secretKey, store, probeSaudavel(), "teste")

	casos := []struct {
		metodo  string
		caminho string
		quer    int
	}{
		{http.MethodPost, "/webhooks/pagarme", http.StatusOK},
		{http.MethodGet, "/health", http.StatusOK},
		// Rota que não existe: 404 do ServeMux, não um handler genérico.
		{http.MethodGet, "/webhooks/pagarme", http.StatusMethodNotAllowed},
		{http.MethodGet, "/internal/pagarme/pending", http.StatusNotFound},
		{http.MethodPost, "/", http.StatusNotFound},
	}

	for _, c := range casos {
		req := httptest.NewRequest(c.metodo, c.caminho, bytes.NewReader([]byte(`{"id":"evt_1"}`)))
		if c.metodo == http.MethodPost && c.caminho == "/webhooks/pagarme" {
			req.Header.Set("X-Hub-Signature", assina([]byte(`{"id":"evt_1"}`)))
		}
		w := httptest.NewRecorder()
		s.Rotas().ServeHTTP(w, req)
		if w.Code != c.quer {
			t.Errorf("%s %s = %d, quer %d", c.metodo, c.caminho, w.Code, c.quer)
		}
	}
}

// -----------------------------------------------------------------------------
// /health
// -----------------------------------------------------------------------------

// O 200 do healthcheck é o portão do Caddy: é ele que decide se o
// `/webhooks/pagarme` pode passar a apontar para este serviço.
func TestHealth200ComCredencialEbanco(t *testing.T) {
	srv, _ := novoServer(t, &fakeStore{}, secretKey, probeSaudavel())
	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health falhou: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, quer 200", res.StatusCode)
	}
	m := corpo(t, res)
	if m["status"] != "ok" {
		t.Errorf("status = %v, quer ok", m["status"])
	}
	if m["service"] != "pagarme-webhook" {
		t.Errorf("service = %v", m["service"])
	}
	if m["webhookEnabled"] != true {
		t.Errorf("webhookEnabled = %v, quer true", m["webhookEnabled"])
	}
	if _, ok := m["uptimeSeconds"]; !ok {
		t.Error("uptimeSeconds ausente")
	}
	if _, ok := m["version"]; !ok {
		t.Error("version ausente")
	}
}

// Sem pool (o processo foi booted sem `DATABASE_URL` utilizável): 503, porque este
// serviço recusa o webhook com 503 nesse estado.
func TestHealth503SemPool(t *testing.T) {
	srv, _ := novoServer(t, &fakeStore{}, secretKey, nil)
	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health falhou: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, quer 503 sem pool", res.StatusCode)
	}
	m := corpo(t, res)
	if m["webhookEnabled"] != false {
		t.Errorf("webhookEnabled = %v, quer false sem pool", m["webhookEnabled"])
	}
	if m["databaseError"] == nil {
		t.Error("databaseError ausente: o 503 precisa dizer por quê")
	}
}

// Banco que responde ERRO: 503 com o erro do driver.
func TestHealth503QuandoBancoRecusa(t *testing.T) {
	pinger := &pingerFalso{}
	probe := NewHealthProbe(pinger, time.Now())
	probe.poll = 5 * time.Millisecond
	pinger.setErr(errors.New("pq: too many connections"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go probe.Run(ctx)

	srv, _ := novoServer(t, &fakeStore{}, secretKey, probe)
	espera := 400 * time.Millisecond
	if !esperaHealth(srv.URL, http.StatusServiceUnavailable, espera) {
		res, _ := http.Get(srv.URL + "/health")
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		t.Fatalf("/health não degradou em %v: %s", espera, body)
	}
}

// Banco que ACEITA a conexão e depois CONGELA: o caso que o `PingContext` no
// caminho da request nunca resolveria. O probe de fundo tem que degradar pelo
// TEMPO (o último ok ficou velho), e o handler tem que responder dentro do prazo
// de resposta do deploy — que é o que o `switch.sh` e o healthcheck do Docker
// cobram.
func TestHealth503QuandoBancoCongela(t *testing.T) {
	pinger := novoPingerMutavel()
	t.Cleanup(pinger.destrava)
	probe := NewHealthProbe(pinger, time.Now())
	probe.poll = 5 * time.Millisecond
	probe.timeout = 20 * time.Millisecond
	probe.staleAfter = 60 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go probe.Run(ctx)

	// Deixa um probe bom acontecer, e aí o banco some de vez: a partir daqui cada
	// pergunta fica presa para sempre, IGNORANDO o prazo do contexto — que é
	// exatamente o defeito do lib/pq que o probe de fundo existe para contornar.
	time.Sleep(50 * time.Millisecond)
	pinger.congela()

	srv, _ := novoServer(t, &fakeStore{}, secretKey, probe)

	// O banco nunca mais responde; o /health tem que degradar sozinho.
	if !esperaHealth(srv.URL, http.StatusServiceUnavailable, 3*time.Second) {
		res, _ := http.Get(srv.URL + "/health")
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		t.Fatalf("/health não degradou com o banco congelado: %s", body)
	}

	// E tem que responder DENTRO do prazo de resposta do deploy, não ficar
	// pendurado esperando o ping preso.
	inicio := time.Now()
	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health falhou com o banco congelado: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if decorrido := time.Since(inicio); decorrido > 500*time.Millisecond {
		t.Errorf("/health levou %v para responder; o switch.sh usa `curl -m 2` e o Docker `timeout: 5s`", decorrido)
	}
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, quer 503 (%s)", res.StatusCode, body)
	}

	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("resposta não é JSON: %v (%s)", err, body)
	}
	if msg, _ := m["databaseError"].(string); msg == "" {
		t.Error("databaseError ausente: o operador precisa saber que é banco travado, não recusa")
	}
	if _, ok := m["databaseLastOkSeconds"]; !ok {
		t.Error("databaseLastOkSeconds ausente")
	}
}

// O probe destrava sozinho, sem restart: o que volta para 200 é a única forma de
// provar que o estado "degradado" é do TEMPO e não de um latch.
func TestHealthVoltaPara200QuandoODestravaOBanco(t *testing.T) {
	pinger := novoPingerMutavel()
	probe := NewHealthProbe(pinger, time.Now())
	probe.poll = 5 * time.Millisecond
	probe.timeout = 20 * time.Millisecond
	probe.staleAfter = 60 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go probe.Run(ctx)

	srv, _ := novoServer(t, &fakeStore{}, secretKey, probe)

	pinger.congela()
	if !esperaHealth(srv.URL, http.StatusServiceUnavailable, 3*time.Second) {
		t.Fatal("/health não degradou")
	}

	// O banco volta. As perguntas presas voltam junto (o socket tem dado
	// pendente no kernel), e a próxima já é uma conexão nova.
	pinger.destrava()

	if !esperaHealth(srv.URL, http.StatusOK, 3*time.Second) {
		res, _ := http.Get(srv.URL + "/health")
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		t.Fatalf("/health não voltou para 200 sozinho após destravar: %s", body)
	}
}

// O `drainEnabled` no /health é lido a cada chamada, e precisa refletir a env
// AGORA — é o campo que o operador olha para saber por que dois workers dividem
// a mesma fila.
func TestHealthRefleteOGateDoDrain(t *testing.T) {
	for _, gate := range []struct {
		valor string
		quer  bool
	}{
		{"", false},
		{"1", true},
		{"sim", false}, // valor inválido não liga
	} {
		t.Run("PAGARME_DRAIN="+gate.valor, func(t *testing.T) {
			t.Setenv("PAGARME_DRAIN", gate.valor)
			srv, _ := novoServer(t, &fakeStore{}, secretKey, probeSaudavel())

			res, err := http.Get(srv.URL + "/health")
			if err != nil {
				t.Fatalf("GET /health falhou: %v", err)
			}
			defer res.Body.Close()
			m := corpo(t, res)
			if m["drainEnabled"] != gate.quer {
				t.Errorf("drainEnabled = %v, quer %v", m["drainEnabled"], gate.quer)
			}
			if m["webhookOwned"] != gate.quer {
				t.Errorf("webhookOwned = %v, quer %v (é a mesma env: quem aponta o proxy é quem drena)", m["webhookOwned"], gate.quer)
			}
		})
	}
}

// `drainEnabled:false` com o resto saudável tem que ser 200 — é o estado NORMAL de
// subida lado a lado (o dono do webhook é o Node, e este serviço só grava a inbox).
// Degradar esse estado quebraria o `docker compose --profile pagarme-webhook`.
func TestHealth200ComDrainDesligado(t *testing.T) {
	t.Setenv("PAGARME_DRAIN", "")
	srv, _ := novoServer(t, &fakeStore{}, secretKey, probeSaudavel())

	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health falhou: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, quer 200 com o drain desligado: é o modo de subida lado a lado", res.StatusCode)
	}
	m := corpo(t, res)
	if m["drainEnabled"] != false {
		t.Errorf("drainEnabled = %v", m["drainEnabled"])
	}
	if m["webhookEnabled"] != true {
		t.Errorf("webhookEnabled = %v: gravar na inbox não depende do gate", m["webhookEnabled"])
	}
}

// esperaHealth faz GET /health até o status bater ou o prazo estourar.
func esperaHealth(base string, quer int, prazo time.Duration) bool {
	fim := time.Now().Add(prazo)
	for time.Now().Before(fim) {
		res, err := http.Get(base + "/health")
		if err == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode == quer {
				return true
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// -----------------------------------------------------------------------------
// HealthProbe isolado
// -----------------------------------------------------------------------------

// O teto de perguntas em andamento existe para o /health não virar o que esgota o
// pool: cada pergunta presa segura uma conexão para sempre, e este processo tem 10
// (o drain precisa delas).
func TestProbeNaoAcumulaPerguntasPresas(t *testing.T) {
	pinger := &pingerPreso{solta: make(chan struct{})}
	t.Cleanup(func() {
		select {
		case <-pinger.solta:
		default:
			pinger.destrava()
		}
	})
	probe := NewHealthProbe(pinger, time.Now())
	probe.poll = time.Millisecond
	probe.timeout = time.Millisecond // irrelevante: o pinger ignora o prazo
	probe.staleAfter = 30 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go probe.Run(ctx)

	time.Sleep(200 * time.Millisecond)

	probe.mu.Lock()
	presas := len(probe.inFlight)
	probe.mu.Unlock()

	if presas > healthMaxInFlight {
		t.Errorf("%d pergunta(s) presa(s) em andamento, quer no máximo %d", presas, healthMaxInFlight)
	}
	if presas == 0 {
		t.Fatal("nenhuma pergunta em andamento: o duplo não está simulando o banco travado")
	}
	// E o número de chamadas é limitado pelo teto, não pela frequência do poll: sem
	// o teto, 200ms a 1ms seriam 200 perguntas presas.
	if n := atomic.LoadInt32(&pinger.chamadas); n > healthMaxInFlight {
		t.Errorf("%d pergunta(s) disparada(s), quer no máximo %d (o teto tem que barrar, não o poll)", n, healthMaxInFlight)
	}
	// E o /health tem que responder 503 no meio disso tudo, sem esperar nenhuma
	// das perguntas presas.
	if v := probe.Check(); v.ok {
		t.Error("/health ok com duas perguntas presas e o último ok velho")
	}
}

// Destravar o banco devolve as perguntas presas e a próxima janela abre. Sem isto,
// uma rede que engole pacote sem nunca devolver RST deixaria o probe travado para
// sempre — e o teste documenta que a recuperação não depende de perguntar de novo.
func TestProbeDestravaDepois(t *testing.T) {
	pinger := &pingerPreso{solta: make(chan struct{})}
	probe := NewHealthProbe(pinger, time.Now())
	probe.poll = 2 * time.Millisecond
	probe.timeout = time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go probe.Run(ctx)

	time.Sleep(50 * time.Millisecond)
	pinger.destrava()

	// A próxima janela de perguntas tem que conseguir entrar.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		probe.mu.Lock()
		presas := len(probe.inFlight)
		probe.mu.Unlock()
		if presas == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Error("as perguntas presas não foram liberadas depois do destravamento: o probe fica mudo para sempre")
}

// Um "ok" velho deixa de valer, mesmo sem o driver sinalizar nada. É esta linha —
// e só ela — que garante que o /health nunca responda 200 mentindo.
func TestProbeOKVelhoDeixaDeValer(t *testing.T) {
	probe := NewHealthProbe(&pingerFalso{}, time.Now())
	if v := probe.Check(); !v.ok {
		t.Fatal("um probe recém-criado tem que estar ok")
	}
	// Envelhece o último ok além do prazo.
	probe.mu.Lock()
	probe.st.lastOK = time.Now().Add(-10 * healthStaleAfter)
	probe.mu.Unlock()

	if v := probe.Check(); v.ok {
		t.Error("um 'ok' de 30s continua válido: o /health responderia 200 com o banco travado há 30s")
	}
	if v := probe.Check(); v.lastOK.IsZero() {
		t.Error("lastOK sumiu: o operador precisa do último instante bom")
	}
}

// A janela de shutdown não pode derrubar o /health: um probe cancelado pelo
// contexto do processo é a morte do processo, não uma falha do banco.
func TestProbeCanceladoNoShutdownNaoContaComoFalha(t *testing.T) {
	pinger := &pingerFalso{atraso: time.Hour}
	probe := NewHealthProbe(pinger, time.Now())
	probe.poll = time.Millisecond
	probe.timeout = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { probe.Run(ctx); close(done) }()

	time.Sleep(30 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run não voltou depois do cancelamento: goroutine pendurada no shutdown")
	}

	probe.mu.Lock()
	estado := probe.st
	probe.mu.Unlock()
	if estado.lastErr == context.Canceled {
		t.Error("o cancelamento do shutdown foi registrado como falha do banco")
	}
}
