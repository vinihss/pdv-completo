// Package charge traduz o dialeto do Pagar.me V5 para o modelo interno.
//
// Porte de `backend/src/integrations/pagarme/mapper.ts` — só as funções que o
// webhook e a reconciliação usam: `mapStatus` e `mapOrderToCharge` (que chama
// `extractPix` e `pickPayment`). `toCents`, `fromCents`, `mapPaymentMethod` e
// `buildCreateOrderBody` NÃO vêm: são do caminho de CRIAÇÃO de cobrança, que
// continua no Node (ver GO-PAGARME-PLAN.md §"O que continua no Node").
//
// ## Regras deste arquivo
//
//  1. NENHUMA regra de negócio. Aqui só se converte nome, unidade e formato. Se
//     aparece um "se o status for X então o pedido vira Y", está no lugar errado
//     — e é por isso que `applyCharge`, `canMoveTo` e `bridgePaidToOrder`
//     continuam no Node.
//  2. A borda é onde existem centavos. O resto do app fala reais (`real` no
//     schema), porque NUMERIC devolveria string do node-postgres e quebraria
//     round2/moneyEq (ver domain/money.ts).
//  3. TUDO tolerante ao desconhecido. A doc oficial não enumera status, não
//     documenta onde o QR do Pix vem e o schema de resposta da página de criação
//     está copiado do endpoint de cobrança. Então: campo faltando vira
//     ausente, status não reconhecido vira `("", false)` (ver `MapStatus`), e
//     quem chama decide o que fazer.
//
// ## O formato do JSON é o contrato com o Node
//
// `Charge` é serializado e entregue em `POST /internal/pagarme/.../apply`, e o
// lado Node consome como `GatewayCharge` (domain/payment.ts). Os nomes das
// chaves e a OMITIÇÃO do que não veio são contrato, não estilo: `paidAmount`
// ausente e `paidAmount: 0` produzem comportamento diferente em `applyCharge`
// (`charge.paidAmount != null && charge.paidAmount > 0`), então os ponteiros
// com `omitempty` não são conveniência, são a tradução de `undefined` do JS.
package charge

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
)

// Status local, espelhando `PaymentStatus` do domínio
// (`backend/src/domain/payment.ts:43`). É o vocabulário que o Node entende; um
// valor fora daqui é recusado por quem consome (ver GO-PAGARME-PLAN.md §contrato,
// onde o Node precisa de allowlist — o payload agora chega por rede e não só
// do mapper).
const (
	StatusPending           = "pending"
	StatusProcessing        = "processing"
	StatusPaid              = "paid"
	StatusFailed            = "failed"
	StatusCanceled          = "canceled"
	StatusPartiallyRefunded = "partially_refunded"
	StatusRefunded          = "refunded"
)

// ErrNoID é o erro de `MapOrderToCharge` quando o payload não trouxe id.
//
// No Node é `throw new Error("resposta do Pagar.me sem id: não dá para
// reconciliar a cobrança depois")`. É erro explícito, e não `nil`, porque sem id
// não há como reconciliar depois — uma linha órfã seria o jeito permanente de o
// dinheiro aparecer sem cobrança e a auditoria não ter a quem apontar.
var ErrNoID = errors.New("resposta do Pagar.me sem id: não dá para reconciliar a cobrança depois")

// Pix é o QR do gateway, espelhando `GatewayPixData` em camelCase.
type Pix struct {
	QRCode       string `json:"qrCode,omitempty"`
	QRCodeBase64 string `json:"qrCodeBase64,omitempty"`
	QRCodeURL    string `json:"qrCodeUrl,omitempty"`
	Txid         string `json:"txid,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
}

// vazio diz se o Pix não traz nada — é o teste do Node
// (`Object.values(data).some(v => Boolean(v))`).
func (p *Pix) vazio() bool {
	return p == nil || (p.QRCode == "" && p.QRCodeBase64 == "" && p.QRCodeURL == "" && p.Txid == "" && p.ExpiresAt == "")
}

// Charge é `GatewayCharge` do domínio Node, no formato em que vai por JSON.
//
// Os `*string` e `*float64` existem por causa de `undefined` do JS: `null` e
// "ausente" são coisas diferentes em `applyCharge`, e `json:",omitempty"` com
// valor zero SOME a chave em vez de mandar `0`/`""` — que é a diferença entre
// "o gateway não disse" e "o gateway disse zero".
type Charge struct {
	ProviderOrderID   string `json:"providerOrderId"`
	ProviderChargeID  string `json:"providerChargeId,omitempty"`
	ProviderPaymentID string `json:"providerPaymentId,omitempty"`
	// Status já traduzido. Nunca vazio: `MapOrderToCharge` sempre resolve um
	// valor (o fallback é `pending`), igual ao Node.
	Status         string   `json:"status"`
	Amount         float64  `json:"amount"`
	PaidAmount     *float64 `json:"paidAmount,omitempty"`
	RefundedAmount *float64 `json:"refundedAmount,omitempty"`
	Pix            *Pix     `json:"pix,omitempty"`
	// Só o resumo que a V5 devolve: 4 últimos e bandeira. PAN/CVV não existem
	// nestes tipos de propósito.
	CardLast4 string `json:"cardLast4,omitempty"`
	CardBrand string `json:"cardBrand,omitempty"`
}

// -----------------------------------------------------------------------------
// status
// -----------------------------------------------------------------------------

// MapStatus é a tradução de status do gateway para o local.
//
// A doc oficial NÃO lista os valores possíveis (só exemplifica `paid`), então o
// mapa é por comparação case-insensitive e cobre a grafia americana e britânica
// de "canceled".
//
// ## Devolve (status, ok) — e por que `false` em vez de palpite
//
// O Node devolve `null` para valor desconhecido e deixa o chamador decidir. O
// mesmo papel é feito aqui pelo segundo valor de retorno, e não por `""`,
// porque `""` é um `PaymentStatus` INVÁLIDO que viraria `"status": ""` no JSON
// enviado ao Node — e o `applyCharge` gravaria um status que não existe, sem
// erro em lugar nenhum. Um `false` explícito obriga o chamador a tratar.
//
// Gravar "pending" porque o gateway mandou algo novo seria inventar estado
// financeiro, e o efeito colateral errado (mostrar pendente como pago, ou o
// contrário) é pior que não atualizar.
func MapStatus(value string) (string, bool) {
	if value == "" {
		return "", false
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "pending", "waiting":
		return StatusPending, true
	case "processing":
		return StatusProcessing, true
	case "paid", "captured", "confirmed":
		return StatusPaid, true
	case "failed", "chargeback":
		return StatusFailed, true
	case "canceled", "cancelled":
		return StatusCanceled, true
	case "partially_refunded":
		return StatusPartiallyRefunded, true
	case "refunded":
		return StatusRefunded, true
	default:
		return "", false
	}
}

// -----------------------------------------------------------------------------
// tipos do payload externo
//
// Regra: TUDO opcional. Estes tipos descrevem o que a documentação oficial
// mostra, e o que ela mostra é incompleto — `types.ts` do Node tem o mesmo
// desenho e a mesma justificativa. Campos que o mapper não lê (customer, items,
// split, metadata) NÃO foram declarados aqui: struct sem uso é dívida.
// -----------------------------------------------------------------------------

// PixObject é o objeto `pix` do Pagar.me, com os nomes EXTERNOS.
type PixObject struct {
	QRCode           string `json:"qr_code"`
	QRCodeBase64     string `json:"qr_code_base64"`
	QRCodeBase64File string `json:"qr_code_base64_file"`
	QRCodeURL        string `json:"qr_code_url"`
	Txid             string `json:"txid"`
	ExpiresAt        string `json:"expires_at"`
}

// Card é o resumo de cartão que a V5 devolve. Nunca há PAN aqui.
type Card struct {
	LastFourDigits string `json:"last_four_digits"`
	Brand          string `json:"brand"`
}

// Transaction é uma transação. Pode ser a última (`last_transaction`) ou não vir.
//
// Os campos `qr_*` achatados reproduzem o caso 3 do `extractPix` do Node, que
// passa o objeto INTEIRO da transação para `fromPixObject` quando não há
// embrulho `pix` — o `as unknown as Record<string, unknown>` de
// `mapper.ts:137`. Em Go o mesmo efeito sai declarando os mesmos nomes de
// chave JSON no struct da transação.
type Transaction struct {
	Card *Card      `json:"card"`
	Pix  *PixObject `json:"pix"`

	QRCode           string `json:"qr_code"`
	QRCodeBase64     string `json:"qr_code_base64"`
	QRCodeBase64File string `json:"qr_code_base64_file"`
	QRCodeURL        string `json:"qr_code_url"`
	Txid             string `json:"txid"`
	ExpiresAt        string `json:"expires_at"`
}

// solto devolve os campos `qr_*` achatados como um `PixObject`, ou nil se a
// transação não tem nenhum deles.
func (t *Transaction) solto() *PixObject {
	if t == nil {
		return nil
	}
	p := &PixObject{
		QRCode:           t.QRCode,
		QRCodeBase64:     t.QRCodeBase64,
		QRCodeBase64File: t.QRCodeBase64File,
		QRCodeURL:        t.QRCodeURL,
		Txid:             t.Txid,
		ExpiresAt:        t.ExpiresAt,
	}
	if *p == (PixObject{}) {
		return nil
	}
	return p
}

// Payment é um `payments[]`.
type Payment struct {
	ID              string       `json:"id"`
	PaymentMethod   string       `json:"payment_method"`
	Status          string       `json:"status"`
	Amount          Flex         `json:"amount"`
	PaidAmount      Flex         `json:"paid_amount"`
	RefundedAmount  Flex         `json:"refunded_amount"`
	Pix             *PixObject   `json:"pix"`
	LastTransaction *Transaction `json:"last_transaction"`
}

// Order é o `data` do webhook (ou o corpo de `GET /orders/{id}`).
type Order struct {
	ID              string       `json:"id"`
	Status          string       `json:"status"`
	Amount          Flex         `json:"amount"`
	PaidAmount      Flex         `json:"paid_amount"`
	Payments        []Payment    `json:"payments"`
	Pix             *PixObject   `json:"pix"`
	LastTransaction *Transaction `json:"last_transaction"`
}

// WebhookPayload é o corpo do webhook (`{ id, type, created_at, data }`).
//
// O `payload` gravado na inbox é o corpo CRU (ver internal/inbox), então este
// struct é usado para LER da inbox e para extrair `id`/`data.id` no insert —
// nunca para regerar o JSON.
type WebhookPayload struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Data *Order `json:"data"`
}

// EventIDs devolve o par de ids do gateway que a inbox indexa
// (`provider_order_id`, `provider_payment_id`), com o mesmo cálculo do
// `recordWebhookEventUsecase` do Node:
//
//	providerOrderId   = data?.id
//	providerPaymentId = primeiro payments[].id ?? (data.id começa com "pay_" ? data.id : "")
func (p *WebhookPayload) EventIDs() (orderID, paymentID string) {
	if p == nil || p.Data == nil {
		return "", ""
	}
	orderID = p.Data.ID
	for i := range p.Data.Payments {
		if p.Data.Payments[i].ID != "" {
			return orderID, p.Data.Payments[i].ID
		}
	}
	// `??` do Node: o `startsWith("pay_")` só entra quando o `find` não achou
	// id de pagamento.
	if strings.HasPrefix(p.Data.ID, "pay_") {
		return orderID, p.Data.ID
	}
	return orderID, ""
}

// -----------------------------------------------------------------------------
// mapper
// -----------------------------------------------------------------------------

// MapOrderToCharge converte a resposta do gateway em `Charge`.
//
// `providerOrderId` é obrigatório: se o payload não trouxe id, não há como
// reconciliar depois, então isso é erro explícito (`ErrNoID`) em vez de linha
// órfã.
func MapOrderToCharge(order *Order) (*Charge, error) {
	if order == nil || order.ID == "" {
		return nil, ErrNoID
	}

	payment := pickPayment(order)

	// `payment?.last_transaction ?? order.last_transaction`
	var transaction *Transaction
	if payment != nil && payment.LastTransaction != nil {
		transaction = payment.LastTransaction
	} else {
		transaction = order.LastTransaction
	}

	// `mapStatus(payment?.status) ?? mapStatus(order.status) ?? "pending"`:
	// o status do pagamento manda, o do pedido é o plano B, e o fallback final
	// é `pending` — nunca um palpite de estado final.
	status, ok := MapStatus(paymentStatus(payment))
	if !ok {
		if status, ok = MapStatus(order.Status); !ok {
			status = StatusPending
		}
	}

	// A doc não diz se o amount do gateway é o do pagamento ou o total do
	// pedido; o do pagamento é o mais próximo do que estamos cobrindo. `0` aqui
	// significa "a doc não mandou amount" — não "custou R$ 0,00": quem grava tem
	// de conferir contra o valor local da comanda antes de persistir, e a spec
	// §12 já proíbe tratar o corpo da criação como pagamento confirmado.
	amount := 0.0
	switch {
	case payment != nil && payment.Amount.Set:
		amount = round2(payment.Amount.V / 100)
	case order.Amount.Set:
		amount = round2(order.Amount.V / 100)
	}

	c := &Charge{
		ProviderOrderID: order.ID,
		Status:          status,
		Amount:          amount,
		Pix:             extractPix(order),
	}

	// O V5 prefixa por tipo: `or_` pedido, `ch_` cobrança, `pay_` pagamento. O
	// id do topo pode ser qualquer um dos três dependendo de qual endpoint
	// respondeu, então guardamos onde ele estiver em vez de assumir.
	if strings.HasPrefix(order.ID, "ch_") {
		c.ProviderChargeID = order.ID
	}
	switch {
	case payment != nil && payment.ID != "":
		c.ProviderPaymentID = payment.ID
	case strings.HasPrefix(order.ID, "pay_"):
		c.ProviderPaymentID = order.ID
	}

	// `payment?.paid_amount ?? order.paid_amount` — o pagamento manda, o do
	// pedido é o plano B, e "nos dois ausente" é ausente (nil), não 0. O `??`
	// do JS também cai no plano B quando o valor é `null`, e o `Flex` trata
	// `null` como não-vindo — a mesma coisa.
	switch {
	case payment != nil && payment.PaidAmount.Set:
		c.PaidAmount = round2Ptr(payment.PaidAmount.V / 100)
	case order.PaidAmount.Set:
		c.PaidAmount = round2Ptr(order.PaidAmount.V / 100)
	}
	if payment != nil && payment.RefundedAmount.Set {
		c.RefundedAmount = round2Ptr(payment.RefundedAmount.V / 100)
	}

	if transaction != nil && transaction.Card != nil {
		c.CardLast4 = transaction.Card.LastFourDigits
		c.CardBrand = transaction.Card.Brand
	}
	return c, nil
}

// paymentStatus devolve o status do pagamento escolhido, ou "" (que `MapStatus`
// trata como desconhecido) quando não há pagamento escolhido.
func paymentStatus(p *Payment) string {
	if p == nil {
		return ""
	}
	return p.Status
}

// pickPayment escolhe o `payments[]` relevante.
//
// Uma cobrança pode ter vários `payments[]` (o pedido aceita mais de um meio); a
// resolução é "o primeiro cujo status é reconhecível", senão o primeiro. Filtrar
// por método em vez de posição importaria mais do que a doc sustenta aqui.
func pickPayment(order *Order) *Payment {
	if order == nil || len(order.Payments) == 0 {
		return nil
	}
	for i := range order.Payments {
		if _, ok := MapStatus(order.Payments[i].Status); ok {
			return &order.Payments[i]
		}
	}
	return &order.Payments[0]
}

// extractPix procura o QR do Pix no payload, tolerando os caminhos que a
// documentação não garante.
//
// A referência oficial de criação de pedido NÃO menciona `qr_code`, `txid` nem
// `expires_at` em lugar nenhum, e o schema de resposta dela está copiado do
// endpoint de cobrança. Sabendo que o dado existe (é o produto do Pix) mas não
// onde vem, a saída é varrer os caminhos plausíveis em ordem e pegar o primeiro
// que traga conteúdo — em vez de escolher um e ficar devolvendo pagamento sem
// QR para sempre.
//
// A ordem importa: o mais específico primeiro (`payments[].pix`), porque é o
// que a API de hoje devolve; os outros são fallback para variação de versão.
func extractPix(order *Order) *Pix {
	if order == nil {
		return nil
	}

	for i := range order.Payments {
		pay := &order.Payments[i]
		if data := fromPixObject(pay.Pix); data != nil {
			return data
		}
		if pay.LastTransaction == nil {
			continue
		}
		// `payments[].last_transaction.pix`
		if data := fromPixObject(pay.LastTransaction.Pix); data != nil {
			return data
		}
		// QR solto na transação, sem o embrulho `pix`.
		if data := fromPixObject(pay.LastTransaction.solto()); data != nil {
			return data
		}
	}
	// No topo da resposta.
	return fromPixObject(order.Pix)
}

// fromPixObject converte o objeto externo no `Pix` interno, e devolve `nil`
// quando não tem nada (o `temAlgo ? data : undefined` do Node).
func fromPixObject(pix *PixObject) *Pix {
	if pix == nil {
		return nil
	}
	data := &Pix{
		QRCode:       pix.QRCode,
		QRCodeBase64: pix.QRCodeBase64,
		QRCodeURL:    pix.QRCodeURL,
		Txid:         pix.Txid,
		ExpiresAt:    pix.ExpiresAt,
	}
	// `qr_code_base64_file` é o PNG hospedado pelo gateway: entra como URL
	// quando não veio o base64, porque é o que o frontend consegue exibir
	// direto sem montar um data URI gigante no `<img src>`.
	if data.QRCodeBase64 == "" && pix.QRCodeBase64File != "" {
		data.QRCodeURL = pix.QRCodeBase64File
	}
	if data.vazio() {
		return nil
	}
	return data
}

// round2 é `round2` de `backend/src/domain/money.ts`:
//
//	Math.round((v + Number.EPSILON) * 100) / 100
//
// O `+ Number.EPSILON` existe porque `1.005 * 100` dá `100.49999999999999` em
// float64, e sem ele o arredondamento de dinheiro perde um centavo para baixo em
// valores que "são" 1.01. `math.Round` arredonda meio para longe do zero, que é
// o que `Math.round` faz para valor positivo — e todo valor que passa aqui é
// centavos/100, portanto não negativo (centavos nunca é negativo, e o CHECK
// `chk_payment_refunded` do schema impede refunded acima do amount).
func round2(v float64) float64 {
	return math.Round((v+2.220446049250313e-16)*100) / 100
}

// round2Ptr é `round2` que devolve ponteiro, para os campos opcionais.
func round2Ptr(v float64) *float64 {
	r := round2(v)
	return &r
}

// -----------------------------------------------------------------------------
// Flex: o número do JSON que aceita "ausente" e tolera o que não é número
// -----------------------------------------------------------------------------

// Flex existe por causa de um detalhe do Node que um struct Go comum reproduz
// errado. `fromCents` começa com `if (typeof cents !== "number" ||
// !Number.isFinite(cents)) return undefined`. Um `*float64` puro NÃO reproduz:
// `json.Unmarshal` FALHA com erro em `"amount": "1000"` (o Pagar.me já mandou
// número como string em payloads) e em `{}`, e aí o payload inteiro seria
// recusado, enquanto o Node aceitaria e seguiria sem o campo — recusa de
// webhook que não aparece em nenhum log do lado do gateway, que simplesmente
// desiste de reenviar.
//
// Aqui o valor não-numérico vira ausente sem erro: é `undefined` do Node
// escrito em Go.
type Flex struct {
	V   float64
	Set bool
}

// UnmarshalJSON implementa a tolerância. Nunca devolve erro de propósito.
func (f *Flex) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		f.V, f.Set = 0, false
		return nil
	}
	var n float64
	if err := json.Unmarshal(b, &n); err != nil {
		// String, objeto, array, bool: `typeof !== "number"` no Node.
		f.V, f.Set = 0, false
		return nil
	}
	// `Number.isFinite`: um literal JSON não sai de float64, mas `1e400` vira
	// `+Inf` no unmarshal do Go e o Node receberia `Infinity` também — e
	// `Number.isFinite(Infinity)` é false. Mantida a checagem.
	if math.IsInf(n, 0) || math.IsNaN(n) {
		f.V, f.Set = 0, false
		return nil
	}
	f.V, f.Set = n, true
	return nil
}
