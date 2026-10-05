// Package gateway é o cliente HTTP do Pagar.me Core V5 — só a parte que este
// serviço precisa, que é `find()`.
//
// ## O que NÃO vem para cá
//
// `create()`, `cancel()` e `refund()` continuam no Node, e a razão é a mesma que
// mantém `applyCharge` lá: são operações que PEDEM dinheiro, e o pedido vai
// junto com o registro local na mesma decisão de domínio
// (`createPaymentUsecase`, `payment.usecases.ts:256/331/401`). Um Go que criasse
// a cobrança no gateway sem o Node ter gravado a linha local produziria uma
// cobrança no Pagar.me que não existe no PDV — dinheiro pedido sem registro.
//
// ## Retry, e por que não existe aqui
//
// Repetir `GET /orders/{id}` é seguro: é leitura, não move dinheiro. Mas quem
// repete é a reconciliação (`internal/queue`), com o intervalo dela, com o teto
// e com o log — as três coisas que um retry dentro desta função não tem (timer
// invisível, sem contagem, sem registro em `payment_event`). O `PagarmeApiError`
// sai daqui com `Retryable` preenchido justamente para que o chamador decida.
package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"pdv-pagarme-webhook/internal/charge"
)

// DefaultBaseURL é a URL de produção. O sandbox V5 é
// `https://sdx-api.pagar.me/core/v5` — mesma forma de código (spec §3), só
// muda a constante (e a `sk_test_` da credencial).
const DefaultBaseURL = "https://api.pagar.me/core/v5"

// DefaultTimeout é o orçamento de uma chamada.
//
// 15s é o mesmo número do Node (`PAGARME_TIMEOUT_MS`): o gateway pode demorar na
// antifraude de cartão e este serviço roda no MESMO caminho, então mudar o número
// aqui e não lá criaria dois lugares com nomes diferentes para o mesmo tempo
// esperado.
const DefaultTimeout = 15 * time.Second

// maxResponseBytes é o teto do corpo. Um `GET /orders/{id}` com `items` e
// `payments` cabe folgado em 1 MiB.
const maxResponseBytes = 2 << 20

// Kind é a classificação do erro, espelhando o `kind` de `PagarmeApiError`
// (`backend/src/integrations/pagarme/client.ts:25`). Os mesmos nomes, porque o
// `paymentEvent.error_message` que o Node grava em cima do erro que este
// pacote produz é lido por gente que conhece o vocabulário do Node.
type Kind string

const (
	KindValidation  Kind = "validation"
	KindAuth        Kind = "auth"
	KindConflict    Kind = "conflict"
	KindRateLimit   Kind = "rate_limit"
	KindUnavailable Kind = "unavailable"
	KindUnknown     Kind = "unknown"
)

// APIError é o erro da chamada ao gateway, já classificado.
//
// `Retryable` é a resposta honesta a "o gateway pode repetir sozinho?" — só 429
// e 5xx. Um 4xx é recusa de regra/validação: repetir devolve a mesma coisa.
type APIError struct {
	Message   string
	Status    int
	Kind      Kind
	Retryable bool
}

func (e *APIError) Error() string {
	if e.Status == 0 {
		return e.Message
	}
	return fmt.Sprintf("HTTP %d (%s): %s", e.Status, e.Kind, e.Message)
}

// AsError devolve o erro como `*APIError`, ou nil.
func AsError(err error) (*APIError, bool) {
	var e *APIError
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// classify é a MESMA tabela do `classify` do Node (client.ts:25).
func classify(status int) (Kind, bool) {
	switch status {
	case 401, 403:
		return KindAuth, false
	case 409:
		return KindConflict, false
	case 429:
		return KindRateLimit, true
	}
	// 4xx restante é recusa de regra/validação — repetir não muda a resposta.
	if status >= 400 && status < 500 {
		return KindValidation, false
	}
	if status >= 500 {
		return KindUnavailable, true
	}
	return KindUnknown, false
}

// Client fala com o Pagar.me.
type Client struct {
	baseURL    string
	secretKey  string
	httpClient *http.Client
	// timeout por chamada. Fica no cliente (e não só no `http.Client`) porque o
	// `Timeout` do http.Client cobre o corpo INTEIRO, e o que interessa aqui é o
	// mesmo que o Node importa: o orçamento total da chamada.
	timeout time.Duration
}

// New monta o Client.
func New(baseURL, secretKey string, timeout time.Duration) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{
		baseURL:   strings.TrimRight(baseURL, "/"),
		secretKey: secretKey,
		// Sem `Timeout` no http.Client: cada request carrega o seu contexto com
		// deadline (ver get), o que é o que permite que a reconciliação cancle
		// uma requisição no meio sem esperar o `http.Client` inteiro.
		httpClient: &http.Client{},
		timeout:    timeout,
	}
}

// TemCredencial diz se há secret key. `false` = a reconciliação não pode rodar
// (e é o mesmo sinal que faz o webhook responder 503).
func (c *Client) TemCredencial() bool { return c.secretKey != "" }

// Find é `GET /orders/{id}` — a fonte de verdade quando o webhook se perde.
//
// `nil` sem erro quando o gateway responde 404: "o gateway não conhece esse id"
// é um RESULTADO, não uma falha — a mesma semântica do `find` do Node
// (`gateway.ts:73`). A reconciliação trata isso como "deixa como está", e é o que
// impede que um pedido há muito tempo sem cobrança vire erro a cada ciclo.
//
// A tradução do corpo é `charge.MapOrderToCharge`, o mesmo mapper do webhook: um
// payload de `find` e um `data` de webhook têm a mesma forma, e dois tradutores
// garantiriam duas respostas diferentes para o mesmo pedido.
func (c *Client) Find(ctx context.Context, providerOrderID string) (*charge.Charge, error) {
	if c.secretKey == "" {
		return nil, &APIError{Message: "PAGARME_SECRET_KEY não configurada", Status: 0, Kind: KindAuth}
	}
	if providerOrderID == "" {
		return nil, &APIError{Message: "find sem providerOrderId", Status: 0, Kind: KindValidation}
	}

	url := c.baseURL + "/orders/" + providerOrderID

	reqCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, &APIError{Message: "não consegui montar a requisição: " + err.Error(), Kind: KindUnknown}
	}
	req.Header.Set("accept", "application/json")
	// A V5 declara `securitySchemes: { sec0: { type: "http", scheme: "basic" } }`
	// — é HTTP Basic com a secret key como usuário e senha VAZIA. NÃO é Bearer,
	// e mandar Bearer dá 401 do gateway.
	req.Header.Set("authorization", basicAuth(c.secretKey))

	res, err := c.httpClient.Do(req)
	if err != nil {
		// Timeout e rede caem aqui. Retryable, porque o gateway pode estar
		// momentaneamente fora — e o preço de errar é um ciclo a mais, não
		// dinheiro (é leitura).
		return nil, &APIError{Message: "falha de rede em GET " + url + ": " + err.Error(), Status: 0, Kind: KindUnavailable, Retryable: true}
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return nil, &APIError{
			Message:   "resposta truncada em GET " + url,
			Status:    res.StatusCode,
			Kind:      KindUnavailable,
			Retryable: res.StatusCode >= 500 || res.StatusCode == 429,
		}
	}

	// 404 = o gateway não conhece o id. Resultado, não erro — paridade com o
	// `if (res.status === 404) return null` do `pagarmeFetch`.
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}

	if res.StatusCode >= 400 {
		kind, retryable := classify(res.StatusCode)
		return nil, &APIError{
			Message:   errorMessage(res.StatusCode, raw),
			Status:    res.StatusCode,
			Kind:      kind,
			Retryable: retryable,
		}
	}

	var order charge.Order
	if err := json.Unmarshal(raw, &order); err != nil {
		return nil, &APIError{
			Message:   "corpo de GET /orders/{id} não é JSON válido: " + err.Error(),
			Status:    res.StatusCode,
			Kind:      KindUnavailable,
			Retryable: true,
		}
	}

	// O corpo veio e não tem `id`: isso é o gateway em estado impossível, e
	// devolve erro em vez de uma `Charge` sem `providerOrderId` — que o Node
	// não conseguiria casar com nenhuma cobrança local.
	found, err := charge.MapOrderToCharge(&order)
	if err != nil {
		return nil, &APIError{
			Message:   fmt.Sprintf("GET /orders/%s respondeu sem id: %v", providerOrderID, err),
			Status:    res.StatusCode,
			Kind:      KindValidation,
			Retryable: false,
		}
	}
	return found, nil
}

// basicAuth monta `Basic base64(secretKey + ":")`.
//
// A senha VAZIA é o que a doc declara. `base64.StdEncoding` da stdlib produz
// exatamente a mesma string que `Buffer.from(secretKey + ":").toString("base64")`
// do Node — e é essa string que o gateway compara, então qualquer diferença de
// padding apareceria como 401 sem explicação.
func basicAuth(secretKey string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(secretKey+":"))
}

// errorMessage extrai uma mensagem legível do corpo de erro.
//
// A doc oficial não define o envelope (o OpenAPI traz `properties: {}`), então
// isto é tolerante: tenta as formas que a API costuma usar e cai no texto cru,
// exatamente como o `errorMessage` do `client.ts:40`.
func errorMessage(status int, body []byte) string {
	if len(body) > 0 {
		var envelope struct {
			Message string `json:"message"`
			Errors  []struct {
				Message string `json:"message"`
				Field   string `json:"field"`
			} `json:"errors"`
		}
		if err := json.Unmarshal(body, &envelope); err == nil {
			if envelope.Message != "" {
				return envelope.Message
			}
			if len(envelope.Errors) > 0 {
				partes := make([]string, 0, len(envelope.Errors))
				for _, e := range envelope.Errors {
					p := e.Message
					if e.Field != "" {
						p = e.Field + ": " + e.Message
					}
					if p != "" {
						partes = append(partes, p)
					}
				}
				if len(partes) > 0 {
					return strings.Join(partes, "; ")
				}
			}
		}
		if texto := strings.TrimSpace(string(body)); texto != "" {
			return texto
		}
	}
	return fmt.Sprintf("HTTP %d sem corpo de erro", status)
}
