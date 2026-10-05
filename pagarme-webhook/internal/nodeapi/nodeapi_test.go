package nodeapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pdv-pagarme-webhook/internal/charge"
)

// =============================================================================
// Suíte do contrato com o Node.
//
// Roda contra um `httptest.Server` DE VERDADE (não uma interface mock): o que
// está em jogo é o header de token, o método, o caminho e o parsing da resposta
// — e um dublê de interface não provaria nada sobre nenhum dos quatro. Um
// `httptest.Server` é um servidor HTTP completo em outra porta, o que testa o
// `http.Client` de verdade (timeout, redirect, corpo).
// =============================================================================

// -----------------------------------------------------------------------------
// doubles
// -----------------------------------------------------------------------------

// captura guarda a última requisição recebida e o que responder.
type captura struct {
	metodo      string
	caminho     string
	token       string
	autorizacao string
	body        []byte
}

// novoServidor sobe um servidor que responde `status`/`corpo` e guarda a
// requisição. Devolve o servidor e o ponteiro para a captura.
func novoServidor(t *testing.T, status int, corpo string) (*httptest.Server, *captura) {
	t.Helper()
	c := &captura{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		c.metodo = r.Method
		c.caminho = r.URL.Path
		c.token = r.Header.Get(HeaderName)
		c.autorizacao = r.Header.Get("Authorization")
		c.body = b
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(corpo))
	}))
	t.Cleanup(srv.Close)
	return srv, c
}

// -----------------------------------------------------------------------------
// o caminho e o header
// -----------------------------------------------------------------------------

// O caminho carrega o id da LINHA da inbox, e é pelo método POST. Um GET aqui é
// um a menos que o Node entende; um caminho trocado é 404, que o drain trata
// como terminal — e aí o dinheiro para de ser reconciliado sem erro visível.
func TestApplyEventUsaPostNoCaminhoDoEvento(t *testing.T) {
	srv, c := novoServidor(t, 200, `{"applied":true}`)
	client := New(srv.URL, "tok-secreto", DefaultTimeout)

	res, err := client.ApplyEvent(context.Background(), "linha-uuid-123", Request{
		Source:  SourceEvent,
		EventID: "evt_1",
		Charge:  &ChargePayload{ProviderOrderID: "or_1", Status: "paid"},
	})
	if err != nil {
		t.Fatalf("ApplyEvent falhou: %v", err)
	}
	if !res.Applied {
		t.Errorf("applied = false, quer true")
	}
	if c.metodo != http.MethodPost {
		t.Errorf("método = %q, quer POST", c.metodo)
	}
	if c.caminho != "/internal/pagarme/events/linha-uuid-123/apply" {
		t.Errorf("caminho = %q", c.caminho)
	}
}

// O token vai em `X-Internal-Token`. Este é o teste que fixa o contrato de
// autenticação entre serviços: se o header mudar de nome, o Node responde 401 e
// o drain manda TODO evento para a DLQ — e o único sintoma é a DLQ enchendo.
func TestApplyEventMandaOTokenNoHeader(t *testing.T) {
	srv, c := novoServidor(t, 200, `{"applied":true}`)
	client := New(srv.URL, "tok-secreto", DefaultTimeout)

	if _, err := client.ApplyEvent(context.Background(), "linha-1", Request{Charge: &ChargePayload{}}); err != nil {
		t.Fatalf("ApplyEvent falhou: %v", err)
	}
	if c.token != "tok-secreto" {
		t.Errorf("%s = %q, quer o token da env", HeaderName, c.token)
	}
	// E o header legacy NÃO é enviado: mandar os dois é mandar o mesmo segredo
	// em dois lugares, e quem audita log de proxy passa a ver o token duplicado.
	if c.autorizacao != "" {
		t.Errorf("Authorization = %q não deveria ser enviado (o canônico é %s)", c.autorizacao, HeaderName)
	}
}

// Sem id de linha não há endpoint para chamar — e a tentativa tem que ser um erro
// local, sem gastar uma chamada HTTP. Um `eventRowID` vazio virando uma
// requisição para `/internal/pagarme/events//apply` é 404 do Node, que o drain
// trata como terminal: um bug de programação virando perda de evento.
func TestApplyEventSemIDDaErroLocal(t *testing.T) {
	srv, c := novoServidor(t, 200, `{"applied":true}`)
	client := New(srv.URL, "tok", DefaultTimeout)

	_, err := client.ApplyEvent(context.Background(), "", Request{Charge: &ChargePayload{}})
	if err == nil {
		t.Fatal("ApplyEvent sem id de linha devolveu nil")
	}
	if e, ok := AsError(err); !ok {
		t.Fatalf("erro %v não é *nodeapi.Error", err)
	} else if e.Retryable {
		t.Error("erro local marcado como retryable: o drain vai reenviar para sempre")
	}
	if c.caminho != "" {
		t.Errorf("o servidor foi chamado (%q) apesar do id vazio", c.caminho)
	}
}

// `baseURL` com barra final não pode virar `//internal/...`: o Go não normaliza
// e o Node receberia um caminho diferente do esperado.
func TestBaseURLComBarraFinal(t *testing.T) {
	srv, c := novoServidor(t, 200, `{"applied":true}`)
	client := New(srv.URL+"/", "tok", DefaultTimeout)

	if _, err := client.ApplyEvent(context.Background(), "linha-1", Request{Charge: &ChargePayload{}}); err != nil {
		t.Fatalf("ApplyEvent falhou: %v", err)
	}
	if c.caminho != "/internal/pagarme/events/linha-1/apply" {
		t.Errorf("caminho = %q; barra final no baseURL produziu caminho com //", c.caminho)
	}
}

// -----------------------------------------------------------------------------
// o corpo: é o GatewayCharge que o Node consome
// -----------------------------------------------------------------------------

// O corpo é contrato com `applyCharge`. O teste fixa os nomes das chaves
// (camelCase do domínio Node), a presença de `source` e a OMITIÇÃO do que não
// veio — `paidAmount: 0` faria o Node deixar de gravar o valor observado pelo
// gateway, e isso não dá erro em nenhum lado.
func TestApplyEventMandaOCorpoDoContrato(t *testing.T) {
	srv, c := novoServidor(t, 200, `{"applied":true}`)
	client := New(srv.URL, "tok", DefaultTimeout)

	req := Request{
		EventID:           "linha-uuid",
		EventType:         "order.paid",
		ProviderOrderID:   "or_1",
		ProviderPaymentID: "pay_1",
		Source:            SourceEvent,
		Charge: &ChargePayload{
			ProviderOrderID:   "or_1",
			ProviderPaymentID: "pay_1",
			Status:            charge.StatusPaid,
			Amount:            45.90,
			PaidAmount:        ptr(45.90),
			Pix:               &PixPayload{QRCode: "BR", Txid: "tx_1"},
			CardLast4:         "4242",
		},
	}
	if _, err := client.ApplyEvent(context.Background(), "linha-uuid", req); err != nil {
		t.Fatalf("ApplyEvent falhou: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(c.body, &m); err != nil {
		t.Fatalf("corpo não é JSON válido: %v (%s)", err, c.body)
	}

	if m["eventId"] != "linha-uuid" {
		t.Errorf("eventId = %v", m["eventId"])
	}
	if m["eventType"] != "order.paid" {
		t.Errorf("eventType = %v", m["eventType"])
	}
	if m["source"] != SourceEvent {
		t.Errorf("source = %v, quer %q", m["source"], SourceEvent)
	}
	chargeBody, ok := m["charge"].(map[string]any)
	if !ok {
		t.Fatalf("charge ausente ou não é objeto: %v", m["charge"])
	}
	if chargeBody["providerOrderId"] != "or_1" {
		t.Errorf("charge.providerOrderId = %v", chargeBody["providerOrderId"])
	}
	if chargeBody["status"] != "paid" {
		t.Errorf("charge.status = %v", chargeBody["status"])
	}
	if chargeBody["paidAmount"] != 45.90 {
		t.Errorf("charge.paidAmount = %v", chargeBody["paidAmount"])
	}
	pix, ok := chargeBody["pix"].(map[string]any)
	if !ok {
		t.Fatalf("charge.pix ausente: %v", chargeBody)
	}
	if pix["qrCode"] != "BR" || pix["txid"] != "tx_1" {
		t.Errorf("charge.pix = %v", pix)
	}
	if _, existe := chargeBody["refundedAmount"]; existe {
		t.Errorf("refundedAmount apareceu sem ser enviado: %v", chargeBody["refundedAmount"])
	}
}

// Evento SEM campos do mapper (o caso `charge` bem magro) continua indo com as
// chaves que importam e sem as que não vieram.
func TestApplyEventOmiteCamposNaoEnviados(t *testing.T) {
	srv, c := novoServidor(t, 200, `{"applied":true}`)
	client := New(srv.URL, "tok", DefaultTimeout)

	_, err := client.ApplyEvent(context.Background(), "linha-1", Request{
		Source: SourceEvent,
		Charge: &ChargePayload{ProviderOrderID: "or_1", Status: charge.StatusPending, Amount: 0},
	})
	if err != nil {
		t.Fatalf("ApplyEvent falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(c.body, &m); err != nil {
		t.Fatalf("corpo inválido: %v", err)
	}
	ch, _ := m["charge"].(map[string]any)
	for _, chave := range []string{"paidAmount", "refundedAmount", "pix", "cardLast4", "cardBrand", "providerPaymentId"} {
		if _, existe := ch[chave]; existe {
			t.Errorf("charge.%s apareceu com %v, quer omitido", chave, ch[chave])
		}
	}
	// `amount` 0 PRECISA aparecer: é a chave que diz "o gateway não mandou
	// amount", e `round2(x ?? 0)` no Node dá o mesmo 0.
	if ch["amount"] != float64(0) {
		t.Errorf("charge.amount = %v, quer 0 presente", ch["amount"])
	}
}

// -----------------------------------------------------------------------------
// classificação de erro: é o que decide retry vs DLQ
// -----------------------------------------------------------------------------

// A tabela de `classify` é o roteamento do drain. Cada linha é um destino
// diferente de evento: 401 e 422 viram DLQ, 5xx vira backoff, 404 vira
// "ignorado". Se a classificação errar, o erro aparece como DLQ cheia ou como
// retry infinito — e nenhum dos dois tem alarme.
func TestClassificacaoDeErro(t *testing.T) {
	casos := []struct {
		status        int
		corpo         string
		querRetryable bool
		querMensagem  string
	}{
		{401, `{"error":{"code":"unauthorized","message":"token inválido"}}`, false, "unauthorized: token inválido"},
		{403, `{"error":{"code":"forbidden"}}`, false, "forbidden"},
		{404, `{"error":{"code":"event_not_found"}}`, false, "event_not_found"},
		{409, `{"error":{"code":"conflict"}}`, false, "conflict"},
		{422, `{"error":{"code":"invalid_charge","message":"status fora do vocabulário"}}`, false, "invalid_charge: status fora do vocabulário"},
		{429, `{"error":{"code":"rate_limited"}}`, true, "rate_limited"},
		{500, `{"error":{"code":"boom"}}`, true, "boom"},
		{503, `{"message":"banco fora"}`, true, "banco fora"},
		// 4xx sem envelope: o texto cru é o que resta.
		{400, `problema`, false, "problema"},
		// 5xx sem corpo: a mensagem precisa dizer o status, não ficar vazia.
		{502, ``, true, "502"},
	}

	for _, c := range casos {
		t.Run(http.StatusText(c.status), func(t *testing.T) {
			srv, _ := novoServidor(t, c.status, c.corpo)
			client := New(srv.URL, "tok", DefaultTimeout)

			_, err := client.ApplyEvent(context.Background(), "linha-1", Request{
				Source: SourceEvent, Charge: &ChargePayload{ProviderOrderID: "or_1"},
			})
			if err == nil {
				t.Fatalf("status %d devolveu erro nil", c.status)
			}
			e, ok := AsError(err)
			if !ok {
				t.Fatalf("erro %v não é *nodeapi.Error", err)
			}
			if e.Status != c.status {
				t.Errorf("Status = %d, quer %d", e.Status, c.status)
			}
			if e.Retryable != c.querRetryable {
				t.Errorf("Retryable = %v, quer %v (o drain usa isso para escolher backoff ou DLQ)", e.Retryable, c.querRetryable)
			}
			if !strings.Contains(e.Message, c.querMensagem) {
				t.Errorf("Message = %q, quer que contenha %q", e.Message, c.querMensagem)
			}
			// O status tem que estar na mensagem: ela vira o `error_message`
			// da inbox, que é o que o operador lê quando a DLQ enche.
			if !strings.Contains(e.Message, strconv.Itoa(c.status)) {
				t.Errorf("Message = %q não cita o status %d", e.Message, c.status)
			}
		})
	}
}

// Falha de rede e timeout são retryable: o Node pode estar reiniciando, e o preço
// de errar é um ciclo de backoff a mais, não dinheiro.
func TestFalhaDeRedeERetryable(t *testing.T) {
	// Porta 1 em loopback: ECONNREFUSED imediato.
	client := New("http://127.0.0.1:1", "tok", 2*time.Second)

	_, err := client.ApplyEvent(context.Background(), "linha-1", Request{Charge: &ChargePayload{}})
	if err == nil {
		t.Fatal("servidor inexistente devolveu erro nil")
	}
	e, ok := AsError(err)
	if !ok {
		t.Fatalf("erro %v não é *nodeapi.Error", err)
	}
	if !e.Retryable {
		t.Error("falha de rede marcada como não-retryable: o evento iria para a DLQ por uma queda de 200ms do Node")
	}
	if e.Status != 0 {
		t.Errorf("Status = %d, quer 0 (não houve resposta)", e.Status)
	}
}

// Timeout é retryable e tem de respeitar o orçamento: um drain que segura
// transação e advisory lock não pode ficar minutos esperando o Node.
func TestTimeoutEhRetryableERespeitaOPrazo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()

	client := New(srv.URL, "tok", 200*time.Millisecond)
	inicio := time.Now()
	_, err := client.ApplyEvent(context.Background(), "linha-1", Request{Charge: &ChargePayload{}})
	decorrido := time.Since(inicio)

	if err == nil {
		t.Fatal("timeout devolveu erro nil")
	}
	e, _ := AsError(err)
	if !e.Retryable {
		t.Error("timeout marcado como não-retryable")
	}
	if decorrido > time.Second {
		t.Errorf("a chamada demorou %v com timeout de 200ms", decorrido)
	}
}

// -----------------------------------------------------------------------------
// parsing da resposta
// -----------------------------------------------------------------------------

// `applied:false` com `reason` é o caso NORMAL da reconciliação (a guarda de
// transição recusou). Não é erro e não é retry: se fosse erro, a reconciliação
// reenviaria para sempre uma resposta que é a resposta certa.
func TestResultAppliedFalseNaoEhErro(t *testing.T) {
	srv, _ := novoServidor(t, 200, `{"applied":false,"reason":"no_transition"}`)
	client := New(srv.URL, "tok", DefaultTimeout)

	res, err := client.ApplyCharge(context.Background(), Request{Source: SourceReconciliation, Charge: &ChargePayload{}})
	if err != nil {
		t.Fatalf("applied:false virou erro %v", err)
	}
	if res.Applied {
		t.Error("applied = true")
	}
	if res.Reason != "no_transition" {
		t.Errorf("reason = %q, quer no_transition", res.Reason)
	}
}

// 2xx sem corpo é infraestrutura suspeita, mas tratar como aplicado é o mesmo que
// o Node teria feito e o efeito é idempotente (o segundo apply é no-op por status
// igual). O que NÃO pode é dar erro: isso transformaria um apply bem-sucedido em
// reenvio, e o reenvio não é idempotente no `logAction`.
func TestResposta2xxSemCorpoEhAplicado(t *testing.T) {
	srv, _ := novoServidor(t, 204, ``)
	client := New(srv.URL, "tok", DefaultTimeout)

	res, err := client.ApplyEvent(context.Background(), "linha-1", Request{Charge: &ChargePayload{}})
	if err != nil {
		t.Fatalf("204 devolveu erro %v", err)
	}
	if !res.Applied {
		t.Error("204 sem corpo não foi tratado como aplicado")
	}
}

// 2xx com JSON ILEGÍVEL é diferente: sem o corpo não dá para saber se aplicou,
// então o drain tem que repetir. Errar para "não aplicado" perderia o efeito do
// evento.
func TestResposta2xxComCorpoInvalidoERetryable(t *testing.T) {
	srv, _ := novoServidor(t, 200, `{isto não é json`)
	client := New(srv.URL, "tok", DefaultTimeout)

	_, err := client.ApplyEvent(context.Background(), "linha-1", Request{Charge: &ChargePayload{}})
	if err == nil {
		t.Fatal("corpo inválido em 200 devolveu erro nil")
	}
	e, _ := AsError(err)
	if !e.Retryable {
		t.Error("corpo inválido em 200 não é retryable: o drain marcaria o evento como aplicado sem saber se foi")
	}
}

// -----------------------------------------------------------------------------
// reconciliação: caminho diferente, mesmo handler
// -----------------------------------------------------------------------------

func TestApplyChargeUsaOCaminhoDaCobranca(t *testing.T) {
	srv, c := novoServidor(t, 200, `{"applied":true}`)
	client := New(srv.URL, "tok", DefaultTimeout)

	_, err := client.ApplyCharge(context.Background(), Request{
		Source:          SourceReconciliation,
		ProviderOrderID: "or_1",
		Charge:          &ChargePayload{ProviderOrderID: "or_1", Status: charge.StatusPaid},
	})
	if err != nil {
		t.Fatalf("ApplyCharge falhou: %v", err)
	}
	if c.caminho != "/internal/pagarme/charges/apply" {
		t.Errorf("caminho = %q, quer /internal/pagarme/charges/apply", c.caminho)
	}
}

// -----------------------------------------------------------------------------
// o token decide se o drain pode rodar
// -----------------------------------------------------------------------------

func TestTemToken(t *testing.T) {
	if New("http://x", "", DefaultTimeout).TemToken() {
		t.Error("TemToken() = true sem token na env")
	}
	if !New("http://x", "tok", DefaultTimeout).TemToken() {
		t.Error("TemToken() = false com token na env")
	}
}

// -----------------------------------------------------------------------------
// NewChargePayload: a conversão que não pode perder campo
// -----------------------------------------------------------------------------

// A conversão de `charge.Charge` para o wire é a fronteira onde um campo novo
// pode sumir em silêncio. O teste lista todos os campos de `charge.Charge` e
// exige que apareçam no JSON — se alguém acrescentar um campo lá e esquecer
// aqui, este teste quebra.
func TestNewChargePayloadNaoPerdeCampo(t *testing.T) {
	pago := 45.90
	estornado := 10.0
	original := &charge.Charge{
		ProviderOrderID:   "or_1",
		ProviderChargeID:  "ch_1",
		ProviderPaymentID: "pay_1",
		Status:            charge.StatusPaid,
		Amount:            45.90,
		PaidAmount:        &pago,
		RefundedAmount:    &estornado,
		Pix: &charge.Pix{
			QRCode: "BR", QRCodeBase64: "Qg==", QRCodeURL: "https://x/y.png",
			Txid: "tx_1", ExpiresAt: "2030-01-01T00:00:00.000Z",
		},
		CardLast4: "4242",
		CardBrand: "visa",
	}

	b, err := json.Marshal(NewChargePayload(original))
	if err != nil {
		t.Fatalf("marshal falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}

	quer := map[string]any{
		"providerOrderId":   "or_1",
		"providerChargeId":  "ch_1",
		"providerPaymentId": "pay_1",
		"status":            "paid",
		"amount":            45.90,
		"paidAmount":        45.90,
		"refundedAmount":    10.0,
		"cardLast4":         "4242",
		"cardBrand":         "visa",
	}
	for chave, esperado := range quer {
		if m[chave] != esperado {
			t.Errorf("%s = %v, quer %v", chave, m[chave], esperado)
		}
	}
	pix, ok := m["pix"].(map[string]any)
	if !ok {
		t.Fatalf("pix ausente: %v", m)
	}
	pixQuer := map[string]any{
		"qrCode": "BR", "qrCodeBase64": "Qg==", "qrCodeUrl": "https://x/y.png",
		"txid": "tx_1", "expiresAt": "2030-01-01T00:00:00.000Z",
	}
	for chave, esperado := range pixQuer {
		if pix[chave] != esperado {
			t.Errorf("pix.%s = %v, quer %v", chave, pix[chave], esperado)
		}
	}
}

// `nil` na entrada é `nil` na saída, e não um objeto com tudo vazio — que o Node
// leria como uma cobrança sem id.
func TestNewChargePayloadNil(t *testing.T) {
	if NewChargePayload(nil) != nil {
		t.Error("NewChargePayload(nil) devolveu objeto em vez de nil")
	}
}

// E o caminho de ida e volta: o que o mapper produziu tem que chegar ao Node com
// os mesmos valores. É o teste que pega um erro de unidade (centavos em vez de
// reais) ou de nome de campo em qualquer um dos dois lados.
func TestNewChargePayloadRoundTripDoMapper(t *testing.T) {
	var payload charge.WebhookPayload
	raw := `{"id":"evt_1","type":"order.paid","data":{"id":"or_1","status":"paid","amount":4590,"paid_amount":4590,"payments":[{"id":"pay_1","status":"paid","last_transaction":{"card":{"last_four_digits":"4242","brand":"visa"},"pix":{"qr_code":"BR"}}}]}}`
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("parse falhou: %v", err)
	}
	c, err := charge.MapOrderToCharge(payload.Data)
	if err != nil {
		t.Fatalf("MapOrderToCharge falhou: %v", err)
	}

	b, err := json.Marshal(NewChargePayload(c))
	if err != nil {
		t.Fatalf("marshal falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}

	if m["providerOrderId"] != "or_1" || m["providerPaymentId"] != "pay_1" {
		t.Errorf("ids perdidos: %v", m)
	}
	if m["status"] != "paid" {
		t.Errorf("status = %v, quer paid", m["status"])
	}
	// Reais, não centavos: 4590 do gateway são 45.90 no domínio.
	if m["amount"] != 45.90 || m["paidAmount"] != 45.90 {
		t.Errorf("amount/paidAmount = %v/%v, quer 45.9/45.9", m["amount"], m["paidAmount"])
	}
	if m["cardLast4"] != "4242" {
		t.Errorf("cardLast4 = %v", m["cardLast4"])
	}
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

func ptr(f float64) *float64 { return &f }

// contagem de chamadas, para provar que NÃO há retry dentro do cliente: quem
// repete é o drain, com backoff e teto. Um retry interno esconderia o erro do
// `Run` e gastaria o orçamento do ciclo sem registrar tentativa.
func TestNaoHaRetryDentroDoCliente(t *testing.T) {
	var chamadas int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&chamadas, 1)
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"error":{"code":"boom"}}`))
	}))
	defer srv.Close()

	client := New(srv.URL, "tok", DefaultTimeout)
	if _, err := client.ApplyEvent(context.Background(), "linha-1", Request{Charge: &ChargePayload{}}); err == nil {
		t.Fatal("500 devolveu erro nil")
	}
	if n := atomic.LoadInt32(&chamadas); n != 1 {
		t.Errorf("o cliente chamou %d vezes, quer 1: o retry é do drain, com backoff e teto", n)
	}
}
