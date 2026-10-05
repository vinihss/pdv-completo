// Package nodeapi é o cliente HTTP do backend Node — o ÚNICO sentido de
// comunicação entre este serviço e o Node.
//
// ## A regra que organiza o sistema inteiro
//
// O Go NUNCA fica no caminho síncrono de um request de usuário, e nunca escreve
// estado de domínio. Quando o drain precisa que um evento vire mudança de
// `payment.status`, ele PERGUNTA ao Node e o Node faz a transação — `applyCharge`,
// `bridgePaidToOrder`, `audit_log` e `outbox_event` continuam lá, dentro da mesma
// transação que já existia (ver `payment.usecases.ts:509`).
//
// Por que não fazer isso no Go, sendo o mesmo banco: `applyCharge` tem regra de
// negócio de verdade (o que cada status faz com `paidAmount`, `refundedAmount`,
// `qrCode`), `bridgePaidToOrder` decide se a linha em `order_payment` já existe
// (idempotência por `(method, amount)`), e o `logAction` escreve `audit_log` +
// `outbox_event` na mesma transação. Reproduzir isso em Go daria DUAS
// implementações da regra financeira com um único banco — que é o jeito mais
// barato de divergir que existe, e a divergência seria silenciosa.
//
// ## At-least-once, e a idempotência vem do Node
//
// Este cliente pode chamar `ApplyEvent` duas vezes para o mesmo `event_id`: o
// `Record` grava, o drain processa, o Node responde 200 e a transação de
// atualização do status COMMITA — e o `UPDATE` de bookkeeping deste processo, na
// transação que segura o advisory lock, ROLLA. O evento volta para elegível e é
// processado de novo. Daí a entrega ser **at-least-once**.
//
// A segurança está no lado Node, e lá já existe:
//   - `applyCharge`: `if (alvo === atual) return row` — o segundo apply do mesmo
//     status é no-op;
//   - `bridgePaidToOrder`: não cria a linha em `order_payment` se já existe
//     confirmada do mesmo `(method, amount)`;
//   - `logAction`: só roda quando o status de fato mudou.
//
// Ou seja: o requisito de idempotência do endpoint interno NÃO é um item novo —
// é a propriedade que `payment.usecases.ts` já tem. O que o endpoint precisa
// fazer é não introduzir um caminho que Escape dela.
package nodeapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"pdv-pagarme-webhook/internal/charge"
)

// HeaderName é o header que carrega o token opaco entre os dois serviços.
//
// `X-Internal-Token` e não `Authorization: Bearer` por um motivo só: o prefixo
// `Bearer` é do esquema de autenticação de USUÁRIO (o JWT do login), e um
// token opaco de serviço vestindo o mesmo formato faz o log de acesso do proxy
// mostrar duas coisas que parecem idênticas e significam coisas diferentes.
// `Authorization` continua aceito pelo Node como alias (ver GO-PAGARME-PLAN.md
// §contrato), mas o canônico é este.
const HeaderName = "X-Internal-Token"

// DefaultTimeout é o orçamento de uma chamada ao Node.
//
// O Node faz a transação inteira — `applyCharge` + `bridgePaidToOrder` +
// `audit_log` + `outbox_event` — dentro da chamada, então o tempo inclui o banco.
// 10s é folga sobre o que isso leva normalmente e curto o bastante para que o
// drain não fique segurando transação + advisory lock por meio minuto (e o
// advisory lock é o que impede o outro drainer de trabalhar).
const DefaultTimeout = 10 * time.Second

// applyTimeout é o teto do corpo da resposta. O Node responde pequeno
// (`{applied:true}`), então 1 MiB é folga absurda e segura.
const maxResponseBytes = 1 << 20

// EventRoute é o caminho do endpoint de evento. `:eventId` é substituído pelo
// id da LINHA da inbox (`payment_event.id`, o UUID), e não pelo `event_id` do
// gateway — o Node precisa do id local para marcar `processed`, e é ele que
// segura o registro de tentativas.
//
// A escolha do id local e nao do `event_id` do gateway é deliberada: o gateway
// reenvia o MESMO `event_id`, e usar o `event_id` na URL tornaria a segunda
// entrega um reenvio (dedupe) ao invés de uma reaplicação idempotente. Como o
// dedupe acontece no `Record`, todo evento na fila tem exatamente uma linha, e é
// essa linha que o endpoint endereça.
const EventRoute = "/internal/pagarme/events/%s/apply"

// ChargeRoute é o caminho do endpoint de reconciliação: mesmo handler, sem evento
// (a reconciliação relê o gateway por conta própria e não tem `payment_event`
// para marcar). Ver GO-PAGARME-PLAN.md §contrato para por que são dois caminhos
// e não um.
const ChargeRoute = "/internal/pagarme/charges/apply"

// SourceEvent e SourceReconciliation rotulam de onde veio a cobrança. O Node usa
// para escolher a GUARDA de transição, e a diferença não é cosmética:
// `applyCharge` grava direto no caminho do webhook (o evento chega na hora e não
// há estado intermediário confiável para checar), mas a reconciliação só releem
// pelo gateway com a leitura podendo estar DIAS atrasada — e aplicar `paid` numa
// cobrança já `refunded` seria reverter dinheiro (`canMoveTo`, `canMoveTo` em
// `payment.usecases.ts:768`).
const (
	SourceEvent          = "event"
	SourceReconciliation = "reconciliation"
)

// Request é o corpo de `ApplyEvent` e de `ApplyCharge`.
//
// `charge` é o `GatewayCharge` do mapper (internal/charge). `eventId` e
// `eventType` são as única coisa que não vêm do mapper: são do ENVELOPE do
// webhook, e o Node precisa do `eventType` para o log de auditoria.
//
// `providerOrderId` e `providerPaymentId` são redundantes com o que está dentro
// de `charge`, e é de propósito: o Node NÃO deve re-extrair do payload bruto. O
// `mapOrderToCharge` é a única tradutora do dialeto do gateway (regra 1 do
// mapper.ts), e um segundo lugar que descobre `pay_` dentro do JSON seria um
// segundo lugar que pode descobrir diferente.
type Request struct {
	EventID           string         `json:"eventId,omitempty"`
	EventType         string         `json:"eventType,omitempty"`
	ProviderOrderID   string         `json:"providerOrderId,omitempty"`
	ProviderPaymentID string         `json:"providerPaymentId,omitempty"`
	Source            string         `json:"source"`
	Charge            *ChargePayload `json:"charge"`
}

// ChargePayload é o `GatewayCharge` que o Node consome.
//
// Todos os campos são ponteiro ou `omitempty` porque a distinção entre "ausente"
// e "zero" é load-bearing no `applyCharge` do Node
// (`if (charge.paidAmount != null && charge.paidAmount > 0)`). Este struct é a
// mesma forma de `charge.Charge` — declarado à parte para que o contrato com o
// Node fique num arquivo só, e para que uma mudança de campo interno não mude o
// wire sem que alguém leia isso.
type ChargePayload struct {
	ProviderOrderID   string      `json:"providerOrderId"`
	ProviderChargeID  string      `json:"providerChargeId,omitempty"`
	ProviderPaymentID string      `json:"providerPaymentId,omitempty"`
	Status            string      `json:"status"`
	Amount            float64     `json:"amount"`
	PaidAmount        *float64    `json:"paidAmount,omitempty"`
	RefundedAmount    *float64    `json:"refundedAmount,omitempty"`
	Pix               *PixPayload `json:"pix,omitempty"`
	CardLast4         string      `json:"cardLast4,omitempty"`
	CardBrand         string      `json:"cardBrand,omitempty"`
}

// PixPayload é o QR do gateway no formato do domínio Node (`GatewayPixData`).
type PixPayload struct {
	QRCode       string `json:"qrCode,omitempty"`
	QRCodeBase64 string `json:"qrCodeBase64,omitempty"`
	QRCodeURL    string `json:"qrCodeUrl,omitempty"`
	Txid         string `json:"txid,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
}

// Result é a resposta de sucesso do Node.
//
// `Applied=false` com `Reason="no_transition"` é o caso NORMAL da
// reconciliação: `canMoveTo` recusou (por exemplo o gateway ainda diz `pending`
// para uma cobrança que já está `paid`). Não é erro e não é retry — é a guarda
// fazendo o papel dela, e o drain precisa distinguir isso de uma falha de
// infraestrutura, que É retryable.
type Result struct {
	Applied bool   `json:"applied"`
	Status  string `json:"status,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// Error é o erro classificado de uma chamada ao Node.
//
// A classificação é o que permite ao drain decidir entre "reenvia com backoff",
// "vai para a DLQ" e "marca ignorado". Ver `queue.Drainer.handle` para a tabela
// completa.
type Error struct {
	Status int
	// Retryable é a resposta honesta a "o Node pode repetir sozinho?":
	// só 5xx e falha de rede. 4xx é recusa de requisição — repetir devolve a
	// mesma coisa.
	Retryable bool
	Message   string
}

func (e *Error) Error() string {
	if e.Status == 0 {
		return fmt.Sprintf("chamada ao backend Node falhou: %s", e.Message)
	}
	return fmt.Sprintf("backend Node respondeu %d: %s", e.Status, e.Message)
}

// AsError devolve o erro como `*Error`, ou nil. Serve para o chamador que
// recebe `error` e precisa da classificação.
func AsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// Client fala com o backend Node.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// New monta o Client.
//
// `baseURL` sem barra final e `token` não vazio. Token vazio é erro de
// configuração e o construtor aceita assim mesmo: quem decide o que fazer sem
// token é o `main`, que sobe o serviço mudo em vez de morrer — o `/health`
// declarando `drainEnabled:false` é mais honesto do que um processo que não
// sobe.
func New(baseURL string, token string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{
		baseURL: trimSlash(baseURL),
		token:   token,
		http:    &http.Client{Timeout: timeout},
	}
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

// TemToken diz se há token para enviar. `false` = o drain não pode rodar.
func (c *Client) TemToken() bool { return c.token != "" }

// NewChargePayload converte a `Charge` do mapper no formato do wire.
//
// A conversão é mecânica e fica num lugar só (e não espalhada pelo drain) por um
// motivo: `charge.Charge` e `ChargePayload` são DUAS structs com a MESMA forma
// em JSON, e existem em pacotes diferentes (o mapper é traduz, o cliente
// transporta). Um campo novo que aparecesse só num dos dois produziria um JSON
// que o Node lê como ausente — que é o modo mais barato de perder dado: sem
// erro, sem 4xx, e o Node degradando para o `?? null`.
func NewChargePayload(c *charge.Charge) *ChargePayload {
	if c == nil {
		return nil
	}
	out := &ChargePayload{
		ProviderOrderID:   c.ProviderOrderID,
		ProviderChargeID:  c.ProviderChargeID,
		ProviderPaymentID: c.ProviderPaymentID,
		Status:            c.Status,
		Amount:            c.Amount,
		PaidAmount:        c.PaidAmount,
		RefundedAmount:    c.RefundedAmount,
		CardLast4:         c.CardLast4,
		CardBrand:         c.CardBrand,
	}
	if c.Pix != nil {
		out.Pix = &PixPayload{
			QRCode:       c.Pix.QRCode,
			QRCodeBase64: c.Pix.QRCodeBase64,
			QRCodeURL:    c.Pix.QRCodeURL,
			Txid:         c.Pix.Txid,
			ExpiresAt:    c.Pix.ExpiresAt,
		}
	}
	return out
}

// ApplyEvent entrega um evento da inbox ao Node.
//
// O `eventRowID` é o `payment_event.id` (UUID local) — ver `EventRoute` para por
// que é este e não o `event_id` do gateway.
func (c *Client) ApplyEvent(ctx context.Context, eventRowID string, req Request) (Result, error) {
	if eventRowID == "" {
		return Result{}, &Error{Status: 0, Retryable: false, Message: "evento sem id da linha: nada a endereçar"}
	}
	route := EventRoute
	// `Sprintf` e não concatenação: o id é um UUID gerado por nós, mas o
	// `%s` deixa explícito que não há escapar de rota aqui.
	return c.post(ctx, fmt.Sprintf(route, eventRowID), req)
}

// ApplyCharge entrega uma cobrança relida do gateway (reconciliação).
func (c *Client) ApplyCharge(ctx context.Context, req Request) (Result, error) {
	return c.post(ctx, ChargeRoute, req)
}

// post faz a chamada e classifica a resposta.
//
// Não há retry dentro desta função, e isso é decisão: quem repete é o drain, e
// ele repete com backoff, com teto e com DLQ — as três coisas que importam e que
// um retry interno (com timer, sem estado e sem registro) não tem. Um retry
// silencioso dentro do cliente também esconderia o erro do `Run`, que é quem
// decide se o ciclo derruba o processo.
func (c *Client) post(ctx context.Context, path string, req Request) (Result, error) {
	body, err := json.Marshal(req)
	if err != nil {
		// Só acontece com valor não serializável, e os campos são primitivos.
		// Não é retryable: repetir não muda o payload.
		return Result{}, &Error{Status: 0, Retryable: false, Message: "não consegui serializar o corpo: " + err.Error()}
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return Result{}, &Error{Status: 0, Retryable: false, Message: "não consegui montar a requisição: " + err.Error()}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set(HeaderName, c.token)

	res, err := c.http.Do(httpReq)
	if err != nil {
		// Timeout e rede caem aqui. Retryable, porque o Node pode estar
		// momentaneamente fora — e o preço de errar é um ciclo de backoff a
		// mais, não dinheiro.
		return Result{}, &Error{Status: 0, Retryable: true, Message: err.Error()}
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return Result{}, &Error{Status: res.StatusCode, Retryable: res.StatusCode >= 500, Message: "resposta truncada: " + err.Error()}
	}

	if res.StatusCode >= 400 {
		return Result{}, classify(res.StatusCode, raw)
	}

	var out Result
	if len(bytes.TrimSpace(raw)) == 0 {
		// 2xx sem corpo. O Node sempre responde JSON, então isto é um proxy no
		// meio ou uma versão futura do endpoint: tratar como aplicado é o
		// mesmo que o Node teria feito, e o efeito é idempotente de qualquer
		// forma (o segundo apply é no-op por status igual).
		log.Printf("[nodeapi] resposta 2xx sem corpo em %s — tratando como aplicado", path)
		return Result{Applied: true}, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		// Corpo ilegível em 2xx é infrastructure: o drain tem que repetir,
		// porque sem o corpo não dá para saber se aplicou.
		return Result{}, &Error{Status: res.StatusCode, Retryable: true, Message: "resposta 2xx com corpo inválido: " + err.Error()}
	}
	return out, nil
}

// classify decide o destino de uma resposta de erro.
//
// A tabela é o contrato de idempotência do drain, e cada linha existe por um
// motivo:
//
//	401/403  token errado ou ausente — configuração. Repetir com o mesmo token
//	         nunca funciona, então é DLQ (e log em nível de erro, que é o que
//	         o operador precisa ver).
//	404      o Node não conhece esse id, o que significa que a linha da
//	         inbox sumiu ou que o Node aponta para OUTRO banco — as duas coisas
//	         precisam aparecer, e retry não conserta nenhuma.
//	409/422  requisição que o Node não vai aceitar (status fora do vocabulário,
//	         payload sem id). Terminal.
//	429/5xx  infraestrutura. Backoff.
//	4xx resto  recusado por regra ou validação. Repetir devolve o mesmo 4xx.
func classify(status int, raw []byte) *Error {
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &envelope)

	msg := envelope.Error.Message
	if msg == "" {
		msg = envelope.Message
	}
	if msg == "" {
		msg = truncate(string(raw), 300)
	}
	if msg == "" {
		// Corpo vazio: o status é tudo que temos, e ele precisa aparecer na
		// mensagem — o `error_message` gravado na inbox é o que o operador vai
		// ler, e "sem corpo de erro" sem o número não diz nada.
		msg = "sem corpo de erro"
	}
	code := envelope.Error.Code
	if code != "" {
		msg = code + ": " + msg
	}

	return &Error{Status: status, Retryable: status == 429 || status >= 500, Message: fmt.Sprintf("HTTP %d: %s", status, msg)}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
