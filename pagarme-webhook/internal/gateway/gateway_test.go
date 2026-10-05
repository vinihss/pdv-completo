package gateway

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// =============================================================================
// Suíte do client do Pagar.me.
//
// Contra `httptest.Server` de verdade: o que está em jogo é o header de
// autenticação (Basic com senha vazia — não Bearer), o tratamento de 404 como
// resultado e não erro, e a classificação de erro. Um dublê de interface não
// provaria nada disso.
// =============================================================================

func TestFindUsaGetNoPathDoPedido(t *testing.T) {
	var caminho, accept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		caminho, accept = r.URL.Path, r.Header.Get("accept")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"or_1","status":"paid","amount":4590}`))
	}))
	defer srv.Close()

	c, err := New(srv.URL, "sk_test_x", 5*time.Second).Find(context.Background(), "or_1")
	if err != nil {
		t.Fatalf("Find falhou: %v", err)
	}
	if caminho != "/orders/or_1" {
		t.Errorf("caminho = %q, quer /orders/or_1", caminho)
	}
	if c.ProviderOrderID != "or_1" {
		t.Errorf("providerOrderId = %q, quer or_1", c.ProviderOrderID)
	}
	if c.Status != "paid" {
		t.Errorf("status = %q, quer paid", c.Status)
	}
	if accept != "application/json" {
		t.Errorf("accept = %q", accept)
	}
}

// A V5 usa HTTP Basic com a secret key como USUÁRIO e senha VAZIA. É o ponto
// mais fácil de errar de um gateway para outro: mandar `Bearer <key>` é o padrão
// da maioria das APIs e devolve 401 sem nenhuma pista. O teste fixa a string
// exata, calculada do lado do Node (`Buffer.from(k + ":").toString("base64")`).
func TestFindAutenticaComBasicESenhaVazia(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("authorization")
		_, _ = w.Write([]byte(`{"id":"or_1"}`))
	}))
	defer srv.Close()

	if _, err := New(srv.URL, "sk_test_chave", 5*time.Second).Find(context.Background(), "or_1"); err != nil {
		t.Fatalf("Find falhou: %v", err)
	}

	quer := "Basic " + base64.StdEncoding.EncodeToString([]byte("sk_test_chave:"))
	if auth != quer {
		t.Errorf("authorization = %q, quer %q", auth, quer)
	}
	if strings.HasPrefix(auth, "Bearer") {
		t.Error("mandou Bearer: a V5 é HTTP Basic, e Bearer dá 401")
	}
}

// -----------------------------------------------------------------------------
// 404 é resultado, não erro
// -----------------------------------------------------------------------------

// "O gateway não conhece esse id" é uma RESPOSTA, não uma falha. Se virar erro,
// a reconciliação trata toda cobrança antiga como falha de infraestrutura — e o
// ciclo inteiro enche de log sem nenhum evento quebrado.
func TestFind404DevolveNilSemErro(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"message":"order not found"}`))
	}))
	defer srv.Close()

	c, err := New(srv.URL, "sk", 5*time.Second).Find(context.Background(), "or_inexistente")
	if err != nil {
		t.Fatalf("404 virou erro %v", err)
	}
	if c != nil {
		t.Errorf("Find devolveu %+v em 404, quer nil", c)
	}
}

// -----------------------------------------------------------------------------
// classificação de erro
// -----------------------------------------------------------------------------

// A tabela é a mesma do `classify` do Node (client.ts:25) e o que está em jogo é
// o que a reconciliação faz com ela: retry (429/5xx) contra "deixa como está"
// (4xx, exceto 429). Trocar um `false` por `true` gera ciclo de retry contra
// gateway que jamais vai responder.
func TestClassificacaoDeErro(t *testing.T) {
	casos := []struct {
		status    int
		corpo     string
		querKind  Kind
		querRetry bool
		querTexto string
	}{
		{401, `{"message":"invalid credentials"}`, KindAuth, false, "invalid credentials"},
		{403, `{"message":"forbidden"}`, KindAuth, false, "forbidden"},
		{409, `{"message":"conflict"}`, KindConflict, false, "conflict"},
		{429, `{"message":"too many"}`, KindRateLimit, true, "too many"},
		{400, `{"message":"bad request"}`, KindValidation, false, "bad request"},
		{422, `{"message":"unprocessable"}`, KindValidation, false, "unprocessable"},
		{500, `{"message":"boom"}`, KindUnavailable, true, "boom"},
		{503, ``, KindUnavailable, true, "503"},
		// Envelope `errors[]` sem `message` no topo: a lista é o plano B.
		{400, `{"errors":[{"field":"amount","message":"must be positive"}]}`, KindValidation, false, "amount: must be positive"},
		// Corpo de texto puro: cai no texto.
		{500, `Internal Server Error`, KindUnavailable, true, "Internal Server Error"},
	}

	for _, c := range casos {
		t.Run(http.StatusText(c.status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.corpo))
			}))
			defer srv.Close()

			_, err := New(srv.URL, "sk", 5*time.Second).Find(context.Background(), "or_1")
			if err == nil {
				t.Fatalf("status %d devolveu erro nil", c.status)
			}
			e, ok := AsError(err)
			if !ok {
				t.Fatalf("erro %v não é *gateway.APIError", err)
			}
			if e.Status != c.status {
				t.Errorf("Status = %d, quer %d", e.Status, c.status)
			}
			if e.Kind != c.querKind {
				t.Errorf("Kind = %q, quer %q", e.Kind, c.querKind)
			}
			if e.Retryable != c.querRetry {
				t.Errorf("Retryable = %v, quer %v", e.Retryable, c.querRetry)
			}
			if !strings.Contains(e.Message, c.querTexto) {
				t.Errorf("Message = %q, quer que contenha %q", e.Message, c.querTexto)
			}
		})
	}
}

// Falha de rede e timeout são retryable: é leitura, o preço de errar é um ciclo a
// mais. E o timeout tem que ser respeitado — a reconciliação segura advisory lock
// enquanto espera, e um gateway travado não pode segurá-lo por minutos.
func TestRedeETimeout(t *testing.T) {
	_, err := New("http://127.0.0.1:1", "sk", 2*time.Second).Find(context.Background(), "or_1")
	if err == nil {
		t.Fatal("servidor inexistente devolveu erro nil")
	}
	if e, _ := AsError(err); e == nil || !e.Retryable {
		t.Errorf("falha de rede: %v, quer retryable", err)
	}

	lento := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer lento.Close()

	inicio := time.Now()
	_, err = New(lento.URL, "sk", 150*time.Millisecond).Find(context.Background(), "or_1")
	if err == nil {
		t.Fatal("timeout devolveu erro nil")
	}
	if decorrido := time.Since(inicio); decorrido > time.Second {
		t.Errorf("a chamada demorou %v com timeout de 150ms", decorrido)
	}
}

// -----------------------------------------------------------------------------
// configuração
// -----------------------------------------------------------------------------

// Sem credencial e sem id: erro local, sem gastar chamada HTTP. Sem credencial
// é `KindAuth` e NÃO retryable — reenviar com a mesma credencial vazia nunca
// funciona, e o `main` já usa `TemCredencial` para não subir a reconciliação.
func TestFindSemCredencialOuSemID(t *testing.T) {
	var chamou bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chamou = true
		_, _ = w.Write([]byte(`{"id":"or_1"}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "", time.Second).Find(context.Background(), "or_1")
	if err == nil {
		t.Fatal("Find sem credencial devolveu erro nil")
	}
	if e, _ := AsError(err); e == nil || e.Kind != KindAuth || e.Retryable {
		t.Errorf("erro %v, quer KindAuth não-retryable", err)
	}

	_, err = New(srv.URL, "sk", time.Second).Find(context.Background(), "")
	if err == nil {
		t.Fatal("Find sem id devolveu erro nil")
	}
	if e, _ := AsError(err); e == nil || e.Kind != KindValidation {
		t.Errorf("erro %v, quer KindValidation", err)
	}

	if chamou {
		t.Error("o servidor foi chamado em caso de erro de configuração")
	}
}

func TestTemCredencial(t *testing.T) {
	if New("", "", time.Second).TemCredencial() {
		t.Error("TemCredencial() = true sem secret key")
	}
	if !New("", "sk", time.Second).TemCredencial() {
		t.Error("TemCredencial() = false com secret key")
	}
}

// O corpo do gateway tem que atravessar o MESMO mapper do webhook. Dois
// tradutores dariam duas respostas diferentes para o mesmo pedido — e a
// reconciliação existe justamente para produce uma resposta confiável.
func TestFindUsaOMesmoMapperDoWebhook(t *testing.T) {
	corpo := `{
	  "id": "or_1",
	  "status": "paid",
	  "amount": 4590,
	  "paid_amount": 4590,
	  "payments": [{"id":"pay_1","status":"paid","paid_amount":4590,
	    "last_transaction":{"card":{"last_four_digits":"1234","brand":"master"}}}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(corpo))
	}))
	defer srv.Close()

	c, err := New(srv.URL, "sk", 5*time.Second).Find(context.Background(), "or_1")
	if err != nil {
		t.Fatalf("Find falhou: %v", err)
	}
	if c.ProviderPaymentID != "pay_1" {
		t.Errorf("providerPaymentId = %q, quer pay_1", c.ProviderPaymentID)
	}
	if c.Amount != 45.90 {
		t.Errorf("amount = %v, quer 45.9 (centavos do gateway viram reais)", c.Amount)
	}
	if c.PaidAmount == nil || *c.PaidAmount != 45.90 {
		t.Errorf("paidAmount = %v, quer 45.9", c.PaidAmount)
	}
	if c.CardLast4 != "1234" || c.CardBrand != "master" {
		t.Errorf("cartão = %q/%q", c.CardLast4, c.CardBrand)
	}
}

// Corpo sem `id` é erro, não uma `Charge` sem identidade: o Node não conseguiria
// casar com nenhuma cobrança local e o evento entraria na reconciliação para
// sempre.
func TestFindCorpoSemIDDaErro(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"paid"}`))
	}))
	defer srv.Close()

	c, err := New(srv.URL, "sk", 5*time.Second).Find(context.Background(), "or_1")
	if err == nil {
		t.Fatalf("corpo sem id devolveu %+v, quer erro", c)
	}
	if e, _ := AsError(err); e == nil || e.Retryable {
		t.Errorf("erro %v, quer não-retryable: o gateway em 2xx sem id é estado dele, não o nosso", err)
	}
}

// 2xx com corpo que não é JSON é retryable: pode ser um proxy no meio, e
// responder "não achou" sem tentar de novo perderia a reconciliação de uma
// cobrança.
func TestFindCorpoInvalidoERetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html>proxy</html>`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "sk", 5*time.Second).Find(context.Background(), "or_1")
	if err == nil {
		t.Fatal("corpo inválido devolveu erro nil")
	}
	if e, _ := AsError(err); e == nil || !e.Retryable {
		t.Errorf("erro %v, quer retryable", err)
	}
}

// Base URL com barra final não pode virar `//orders/`: o caminho errado no
// gateway dá 404, que o `Find` traduz em "não existe" — a reconciliação passaria
// a ignorar todas as cobranças sem erro em lugar nenhum.
func TestBaseURLComBarraFinal(t *testing.T) {
	var caminho string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		caminho = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"or_1"}`))
	}))
	defer srv.Close()

	if _, err := New(srv.URL+"/", "sk", time.Second).Find(context.Background(), "or_1"); err != nil {
		t.Fatalf("Find falhou: %v", err)
	}
	if caminho != "/orders/or_1" {
		t.Errorf("caminho = %q, quer /orders/or_1", caminho)
	}
}

// O contexto cancelado pelo drain tem de abortar a chamada: sem isso, o
// `http.Client` sem `Timeout` seguraria a conexão até o gateway responder, e o
// advisory lock junto.
func TestContextoCanceladoAborta(t *testing.T) {
	soltou := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-soltou
	}))
	defer func() { close(soltou); srv.Close() }()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	inicio := time.Now()
	// Timeout alto: quem tem que abortar é o contexto, não o timeout.
	_, err := New(srv.URL, "sk", 30*time.Second).Find(ctx, "or_1")
	if err == nil {
		t.Fatal("contexto cancelado devolveu erro nil")
	}
	if decorrido := time.Since(inicio); decorrido > 5*time.Second {
		t.Errorf("a chamada levou %v para abortar, quer ordem de milissegundos", decorrido)
	}
}
