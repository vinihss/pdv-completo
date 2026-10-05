package charge

import (
	"encoding/json"
	"errors"
	"testing"
)

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// decode faz o parse do JSON com as MESMAS structs do código, que é o que os
// testes de payload exercitam de verdade: o caminho que corre em produção é
// "bytes do gateway → struct → mapper", e testar só o mapper deixaria a
// tolerância do `Flex` sem cobertura.
func decode(t *testing.T, raw string) *WebhookPayload {
	t.Helper()
	var p WebhookPayload
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("payload não parseou: %v (%s)", err, raw)
	}
	return &p
}

func mapFrom(t *testing.T, raw string) (*Charge, error) {
	t.Helper()
	return MapOrderToCharge(decode(t, raw).Data)
}

func mustMap(t *testing.T, raw string) *Charge {
	t.Helper()
	c, err := mapFrom(t, raw)
	if err != nil {
		t.Fatalf("MapOrderToCharge falhou: %v", err)
	}
	return c
}

// -----------------------------------------------------------------------------
// MapStatus: normalização de cada alias
// -----------------------------------------------------------------------------

// Cada alias da doc (que NÃO enumera status) tem que normalizar para o status
// local. O teste é uma tabela porque o defeito que esta função evita é
// GRAVÁVEL: um alias não mapeado vira "status desconhecido", e o chamador
// escreve `pending` onde o gateway disse `paid` — ou o contrário.
func TestMapStatusNormalizaCadaAlias(t *testing.T) {
	casos := []struct {
		entrada string
		quer    string
	}{
		// pendentes
		{"pending", StatusPending},
		{"waiting", StatusPending},
		// processamento
		{"processing", StatusProcessing},
		// pagos
		{"paid", StatusPaid},
		{"captured", StatusPaid},
		{"confirmed", StatusPaid},
		// falhas
		{"failed", StatusFailed},
		{"chargeback", StatusFailed},
		// cancelados, nas duas grafias
		{"canceled", StatusCanceled},
		{"cancelled", StatusCanceled},
		// estornos
		{"partially_refunded", StatusPartiallyRefunded},
		{"refunded", StatusRefunded},
	}

	for _, c := range casos {
		got, ok := MapStatus(c.entrada)
		if !ok {
			t.Errorf("MapStatus(%q) = não reconhecido, quer %q", c.entrada, c.quer)
			continue
		}
		if got != c.quer {
			t.Errorf("MapStatus(%q) = %q, quer %q", c.entrada, got, c.quer)
		}
	}
}

// A comparação é case-insensitive e com `trim`, porque a doc descreve os valores
// como prosa ("Pix") e o gateway pode mudar a grafia a qualquer momento.
func TestMapStatusIgnoraCaixaEEspaco(t *testing.T) {
	for _, entrada := range []string{"PAID", " Paid ", "CaPtUrEd", "\tconfirmed\n", "CANCELLED"} {
		if _, ok := MapStatus(entrada); !ok {
			t.Errorf("MapStatus(%q) recusou por causa de caixa/espaço", entrada)
		}
	}
	if got, _ := MapStatus("  CANCELLED "); got != StatusCanceled {
		t.Errorf("MapStatus(\"  CANCELLED \") = %q, quer canceled", got)
	}
}

// Status desconhecido devolve `("", false)` e NUNCA um palpite. Este é o ponto
// do arquivo: inventar `pending` para algo que não se reconhece é gravar estado
// financeiro que ninguém confirmou, e o efeito colateral (mostrar pendente como
// pago) é pior que não atualizar nada.
func TestMapStatusDesconhecidoNaoViraPalpite(t *testing.T) {
	desconhecidos := []string{"", "   ", "paid!", "authorized", "in_analysis", "PIX", "REFUNDED_X", "partially refund"}

	for _, entrada := range desconhecidos {
		got, ok := MapStatus(entrada)
		if ok {
			t.Errorf("MapStatus(%q) = %q, quer não reconhecido", entrada, got)
		}
		if got != "" {
			t.Errorf("MapStatus(%q) devolveu %q com ok=false: string vazia é um PaymentStatus INVÁLIDO e viraria \"status\": \"\" no JSON", entrada, got)
		}
	}
}

// -----------------------------------------------------------------------------
// MapOrderToCharge: id obrigatório
// -----------------------------------------------------------------------------

// Sem id não há como reconciliar depois, então é erro explícito e não `nil`. Um
// `nil` silencioso aqui viraria uma linha de `payment_event` que aponta para
// nada e ninguém nunca mais volta atrás.
func TestMapOrderToChargeSemIDDaErro(t *testing.T) {
	casos := []struct {
		nome string
		raw  string
	}{
		{"data ausente", `{"id":"evt_1","type":"order.paid"}`},
		{"data sem id", `{"id":"evt_1","data":{"status":"paid"}}`},
		{"data com id vazio", `{"id":"evt_1","data":{"id":"","status":"paid"}}`},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			_, err := mapFrom(t, c.raw)
			if err == nil {
				t.Fatal("MapOrderToCharge aceitou payload sem id: linha órfã garantida")
			}
			if !errors.Is(err, ErrNoID) {
				t.Fatalf("erro %v, quero ErrNoID", err)
			}
		})
	}

	// `nil` explícito também: é o que o chamador passa quando `payload.data` não
	// veio, e ele não deve chegar a um dereference.
	if _, err := MapOrderToCharge(nil); !errors.Is(err, ErrNoID) {
		t.Fatalf("MapOrderToCharge(nil) = %v, quer ErrNoID", err)
	}
}

// -----------------------------------------------------------------------------
// MapOrderToCharge: o caso do webhook pago
// -----------------------------------------------------------------------------

func TestMapOrderToChargeWebhookPago(t *testing.T) {
	// Payload no formato que a doc descreve para `order.paid`: `data` é o
	// pedido (`or_`), com `payments[]` e a última transação com o cartão.
	raw := `{
	  "id": "evt_abc",
	  "type": "order.paid",
	  "data": {
	    "id": "or_123",
	    "status": "paid",
	    "amount": 4590,
	    "paid_amount": 4590,
	    "payments": [
	      {
	        "id": "pay_456",
	        "payment_method": "credit_card",
	        "status": "paid",
	        "amount": 4590,
	        "paid_amount": 4590,
	        "last_transaction": {
	          "id": "tran_1",
	          "status": "paid",
	          "card": {"id": "card_1", "last_four_digits": "4242", "brand": "visa"}
	        }
	      }
	    ]
	  }
	}`

	c := mustMap(t, raw)

	if c.ProviderOrderID != "or_123" {
		t.Errorf("providerOrderId = %q, quer or_123", c.ProviderOrderID)
	}
	if c.ProviderPaymentID != "pay_456" {
		t.Errorf("providerPaymentId = %q, quer pay_456", c.ProviderPaymentID)
	}
	// `or_` não é `ch_`: o chargeId fica vazio, porque o id do topo é pedido.
	if c.ProviderChargeID != "" {
		t.Errorf("providerChargeId = %q, quer vazio (id `or_` não é `ch_`)", c.ProviderChargeID)
	}
	if c.Status != StatusPaid {
		t.Errorf("status = %q, quer paid", c.Status)
	}
	// Centavos → reais: 4590 vira 45.90, e o valor OBSERVADO manda sobre o
	// valor criado (`applyCharge` usa `paidAmount` com precedência).
	if c.Amount != 45.90 {
		t.Errorf("amount = %v, quer 45.9", c.Amount)
	}
	if c.PaidAmount == nil || *c.PaidAmount != 45.90 {
		t.Errorf("paidAmount = %v, quer 45.9", c.PaidAmount)
	}
	if c.CardLast4 != "4242" {
		t.Errorf("cardLast4 = %q, quer 4242", c.CardLast4)
	}
	if c.CardBrand != "visa" {
		t.Errorf("cardBrand = %q, quer visa", c.CardBrand)
	}
	if c.RefundedAmount != nil {
		t.Errorf("refundedAmount = %v, quer ausente: o gateway não mandou", c.RefundedAmount)
	}
}

// O prefixo do id do topo decide onde ele é guardado: `or_` pedido, `ch_`
// cobrança, `pay_` pagamento. A V5 responde `POST /orders` e `GET /orders/{id}`
// com ids de tipos diferentes dependendo do endpoint, e assumir um deles grava
// `provider_charge_id`/`provider_payment_id` errado — que é o campo por onde o
// evento acha a cobrança local.
func TestMapOrderToChargeGuardaIDPeloPrefixoDoTopo(t *testing.T) {
	casos := []struct {
		nome         string
		raw          string
		querChargeID string
		querPayID    string
	}{
		{
			nome:         "topo e ch_",
			raw:          `{"data":{"id":"ch_999","status":"paid","amount":1000}}`,
			querChargeID: "ch_999",
		},
		{
			nome:      "topo e pay_",
			raw:       `{"data":{"id":"pay_777","status":"pending","amount":1000}}`,
			querPayID: "pay_777",
		},
		{
			nome:         "topo e or_",
			raw:          `{"data":{"id":"or_1","status":"pending","amount":1000}}`,
			querChargeID: "",
			querPayID:    "",
		},
		{
			// `payments[].id` manda sobre o id do topo para providerPaymentId.
			nome:         "payments manda no paymentId",
			raw:          `{"data":{"id":"or_1","payments":[{"id":"pay_1","status":"paid"}]}}`,
			querChargeID: "",
			querPayID:    "pay_1",
		},
		{
			nome:         "prefixo desconhecido nao e adivinhado",
			raw:          `{"data":{"id":"xx_1","status":"paid"}}`,
			querChargeID: "",
			querPayID:    "",
		},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			got := mustMap(t, c.raw)
			if got.ProviderChargeID != c.querChargeID {
				t.Errorf("providerChargeId = %q, quer %q", got.ProviderChargeID, c.querChargeID)
			}
			if got.ProviderPaymentID != c.querPayID {
				t.Errorf("providerPaymentId = %q, quer %q", got.ProviderPaymentID, c.querPayID)
			}
		})
	}
}

// O status do pagamento manda sobre o do pedido, e `pending` é o fallback
// final. O caso perigoso é o terceiro: um pedido com `payments[]` de status
// ilegível e status de topo também ilegível NÃO pode virar `paid` nem inventado —
// vira `pending`, e quem chama decide.
func TestMapOrderToChargeResolucaoDeStatus(t *testing.T) {
	casos := []struct {
		nome string
		raw  string
		quer string
	}{
		{
			nome: "payment manda sobre order",
			raw:  `{"data":{"id":"or_1","status":"pending","payments":[{"id":"pay_1","status":"paid"}]}}`,
			quer: StatusPaid,
		},
		{
			nome: "order e o plano B quando o payment e desconhecido",
			raw:  `{"data":{"id":"or_1","status":"captured","payments":[{"id":"pay_1","status":"estranho"}]}}`,
			quer: StatusPaid,
		},
		{
			nome: "pending quando nenhum dos dois e reconhecivel",
			raw:  `{"data":{"id":"or_1","status":"???","payments":[{"id":"pay_1","status":"???"}]}}`,
			quer: StatusPending,
		},
		{
			nome: "pending quando nao ha payments[]",
			raw:  `{"data":{"id":"or_1"}}`,
			quer: StatusPending,
		},
		{
			// `payments[]` sem status reconhecível: `pickPayment` devolve o
			// primeiro mesmo assim, e o status do pedido entra.
			nome: "sem payments reconheciveis usa o do pedido",
			raw:  `{"data":{"id":"or_1","status":"refunded","payments":[{"id":"pay_1"},{"id":"pay_2","status":"paid"}]}}`,
			quer: StatusPaid,
		},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			got := mustMap(t, c.raw)
			if got.Status != c.quer {
				t.Errorf("status = %q, quer %q", got.Status, c.quer)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// valores: centavos → reais, e a precedência
// -----------------------------------------------------------------------------

// O amount do pagamento tem precedência sobre o do pedido; `null` cai no plano B
// (o `??` do JS trata null como ausente) e `0` NÃO cai — zero é zero.
func TestMapOrderToChargeAmount(t *testing.T) {
	casos := []struct {
		nome string
		raw  string
		quer float64
	}{
		{"payment manda", `{"data":{"id":"or_1","amount":9999,"payments":[{"id":"p","amount":4590}]}}`, 45.90},
		{"order quando payment nao tem amount", `{"data":{"id":"or_1","amount":4590,"payments":[{"id":"p"}]}}`, 45.90},
		{"order quando payment e null", `{"data":{"id":"or_1","amount":4590,"payments":[{"id":"p","amount":null}]}}`, 45.90},
		{"zero e zero", `{"data":{"id":"or_1","amount":0}}`, 0},
		{"sem amount algum", `{"data":{"id":"or_1"}}`, 0},
		{"centavo nao e truncado", `{"data":{"id":"or_1","amount":1}}`, 0.01},
		{"mil centavos", `{"data":{"id":"or_1","amount":100000}}`, 1000},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			got := mustMap(t, c.raw)
			if got.Amount != c.quer {
				t.Errorf("amount = %v, quer %v", got.Amount, c.quer)
			}
		})
	}
}

// Arredondamento de dinheiro: `round2` reproduz o `Math.round((v + EPSILON) *
// 100) / 100` do Node, cujo motivo é `1.005 * 100 === 100.49999999999999`.
// Sem o `+ EPSILON` o mapper devolveria 1.0 em vez de 1.01 — um centavo a menos
// no valor que vai para `applyCharge`.
func TestRound2NaoPerdeCentavoPorFloat(t *testing.T) {
	casos := []struct {
		entrada float64
		quer    float64
	}{
		{1.005, 1.01},
		{2.675, 2.68},
		{0.145, 0.15},
		{10.004999, 10.0},
		{45.9, 45.9},
		{0, 0},
		{4590.0 / 100, 45.9},
	}

	for _, c := range casos {
		if got := round2(c.entrada); got != c.quer {
			t.Errorf("round2(%v) = %v, quer %v", c.entrada, got, c.quer)
		}
	}
}

// -----------------------------------------------------------------------------
// tolerância do Flex
// -----------------------------------------------------------------------------

// Número como string é o caso que um `*float64` comum reprovaria com erro de
// unmarshal — e aí o payload inteiro seria descartado, com o Pagar.me reenviando
// para sempre e nenhum erro do lado dele. O Node aceitaria e seguiria sem o
// campo; aqui é a mesma coisa.
func TestFlexToleraNumeroComoString(t *testing.T) {
	var o Order
	raw := `{"id":"or_1","amount":"4590","paid_amount":"4590"}`
	if err := json.Unmarshal([]byte(raw), &o); err != nil {
		t.Fatalf("payload com número como string não parseou: %v", err)
	}
	if o.Amount.Set {
		t.Errorf("amount = %v (Set=true): o Node devolve undefined para typeof !== number", o.Amount.V)
	}
	if o.PaidAmount.Set {
		t.Errorf("paidAmount = %v (Set=true)", o.PaidAmount.V)
	}
}

// E o caminho completo: um webhook cujo `amount` veio como string tem que virar
// uma `Charge` com amount 0 (o gateway "não disse") e status preservado — nunca
// um erro de parse.
func TestMapOrderToChargeComAmountComoString(t *testing.T) {
	c := mustMap(t, `{"data":{"id":"or_1","status":"paid","amount":"4590"}}`)
	if c.Status != StatusPaid {
		t.Errorf("status = %q, quer paid: o amount ilegível não pode derrubar o status", c.Status)
	}
	if c.Amount != 0 {
		t.Errorf("amount = %v, quer 0 (o gateway não disse)", c.Amount)
	}
}

// O mesmo para objeto e array no lugar de um número.
func TestFlexToleraObjetoEArrayNoLugarDeNumero(t *testing.T) {
	for _, raw := range []string{
		`{"data":{"id":"or_1","amount":{"value":10}}}`,
		`{"data":{"id":"or_1","amount":[10]}}`,
		`{"data":{"id":"or_1","amount":true}}`,
		`{"data":{"id":"or_1","amount":null}}`,
	} {
		if _, err := mapFrom(t, raw); err != nil {
			t.Errorf("payload %s foi recusado com %v; o Node aceitaria", raw, err)
		}
	}
}

// -----------------------------------------------------------------------------
// Pix: os quatro caminhos que o mapper varre
// -----------------------------------------------------------------------------

// A doc oficial consultada NÃO diz de onde vem o QR. O mapper varre quatro
// caminhos em ordem e pega o primeiro com conteúdo, porque escolher um só
// significaria devolver pagamento sem QR para sempre — e o cliente do balcão
// ficaria sem como pagar no Pix.
func TestExtractPixVarreOsCaminhos(t *testing.T) {
	casos := []struct {
		nome        string
		raw         string
		querQR      string
		querBase64  string
		querURL     string
		querTxid    string
		querExpires string
	}{
		{
			nome:        "1) payments[].pix — caminho de hoje",
			raw:         `{"data":{"id":"or_1","payments":[{"id":"pay_1","pix":{"qr_code":"BR_CODE","qr_code_base64":"QkFTRTY0","txid":"tx_1","expires_at":"2030-01-01T00:00:00.000Z"}}]}}`,
			querQR:      "BR_CODE",
			querBase64:  "QkFTRTY0",
			querTxid:    "tx_1",
			querExpires: "2030-01-01T00:00:00.000Z",
		},
		{
			nome:   "2) payments[].last_transaction.pix",
			raw:    `{"data":{"id":"or_1","payments":[{"id":"pay_1","last_transaction":{"pix":{"qr_code":"BR_TX"}}}]}}`,
			querQR: "BR_TX",
		},
		{
			nome:   "3) qr solto na transacao, sem o embrulho pix",
			raw:    `{"data":{"id":"or_1","payments":[{"id":"pay_1","last_transaction":{"qr_code":"BR_SOLTO"}}]}}`,
			querQR: "BR_SOLTO",
		},
		{
			nome:   "4) no topo da resposta",
			raw:    `{"data":{"id":"or_1","pix":{"qr_code":"BR_TOPO"}}}`,
			querQR: "BR_TOPO",
		},
		{
			nome:    "base64_file vira URL quando nao veio base64",
			raw:     `{"data":{"id":"or_1","pix":{"qr_code_base64_file":"https://cdn/x.png"}}}`,
			querURL: "https://cdn/x.png",
		},
		{
			// Com base64 presente, o `base64_file` NÃO sobrescreve a URL que o
			// gateway mandou: é o `if (!data.qrCodeBase64 && ...)` do Node.
			nome:       "base64 presente mantem a URL original",
			raw:        `{"data":{"id":"or_1","pix":{"qr_code_base64":"Qg==","qr_code_url":"https://cdn/y.png","qr_code_base64_file":"https://cdn/x.png"}}}`,
			querBase64: "Qg==",
			querURL:    "https://cdn/y.png",
		},
		{
			// A ordem importa: `payments[].pix` vem antes do resto, mesmo com o
			// do topo presente.
			nome:   "payments[].pix ganha do topo",
			raw:    `{"data":{"id":"or_1","pix":{"qr_code":"BR_TOPO"},"payments":[{"id":"pay_1","pix":{"qr_code":"BR_PAY"}}]}}`,
			querQR: "BR_PAY",
		},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			got := mustMap(t, c.raw)
			if got.Pix == nil {
				t.Fatal("pix = nil: o mapper teria devolvido pagamento sem QR para sempre")
			}
			if got.Pix.QRCode != c.querQR {
				t.Errorf("qrCode = %q, quer %q", got.Pix.QRCode, c.querQR)
			}
			if got.Pix.QRCodeBase64 != c.querBase64 {
				t.Errorf("qrCodeBase64 = %q, quer %q", got.Pix.QRCodeBase64, c.querBase64)
			}
			if got.Pix.QRCodeURL != c.querURL {
				t.Errorf("qrCodeUrl = %q, quer %q", got.Pix.QRCodeURL, c.querURL)
			}
			if got.Pix.Txid != c.querTxid {
				t.Errorf("txid = %q, quer %q", got.Pix.Txid, c.querTxid)
			}
			if got.Pix.ExpiresAt != c.querExpires {
				t.Errorf("expiresAt = %q, quer %q", got.Pix.ExpiresAt, c.querExpires)
			}
		})
	}
}

// Objeto `pix` sem nenhum campo é o mesmo que não vir: o Node devolve `undefined`
// e o `applyCharge` mantém o QR que já estava na linha local.
func TestExtractPixObjetoVazioNaoViaja(t *testing.T) {
	for _, raw := range []string{
		`{"data":{"id":"or_1","pix":{}}}`,
		`{"data":{"id":"or_1","payments":[{"id":"pay_1","pix":{}}]}}`,
		`{"data":{"id":"or_1","payments":[{"id":"pay_1"}]}}`,
	} {
		got := mustMap(t, raw)
		if got.Pix != nil {
			t.Errorf("payload %s devolveu pix %+v, quer ausente", raw, got.Pix)
		}
	}
}

// -----------------------------------------------------------------------------
// EventIDs: os ids que a inbox indexa
// -----------------------------------------------------------------------------

// Paridade com `recordWebhookEventUsecase`: o `provider_payment_id` é o primeiro
// `payments[].id` que existir, e só quando não existe nenhum é que o id do topo
// entra — e só se for `pay_`.
func TestEventIDs(t *testing.T) {
	casos := []struct {
		nome      string
		raw       string
		querOrder string
		querPay   string
	}{
		{
			nome:      "pedido com pagamento",
			raw:       `{"id":"evt_1","data":{"id":"or_1","payments":[{"id":"pay_1"}]}}`,
			querOrder: "or_1",
			querPay:   "pay_1",
		},
		{
			nome:      "topo e pay_",
			raw:       `{"id":"evt_1","data":{"id":"pay_1"}}`,
			querOrder: "pay_1",
			querPay:   "pay_1",
		},
		{
			nome:      "topo e or_ sem payments",
			raw:       `{"id":"evt_1","data":{"id":"or_1"}}`,
			querOrder: "or_1",
		},
		{
			nome:      "payments sem id nao bloqueia o proximo",
			raw:       `{"id":"evt_1","data":{"id":"or_1","payments":[{},{"id":"pay_2"}]}}`,
			querOrder: "or_1",
			querPay:   "pay_2",
		},
		{
			nome: "sem data",
			raw:  `{"id":"evt_1","type":"order.paid"}`,
		},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			order, pay := decode(t, c.raw).EventIDs()
			if order != c.querOrder {
				t.Errorf("providerOrderId = %q, quer %q", order, c.querOrder)
			}
			if pay != c.querPay {
				t.Errorf("providerPaymentId = %q, quer %q", pay, c.querPay)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// o JSON que vai para o Node é contrato
// -----------------------------------------------------------------------------

// O Node consome o `Charge` como `GatewayCharge`, e a diferença entre "ausente"
// e "zero" muda o que `applyCharge` grava
// (`if (charge.paidAmount != null && charge.paidAmount > 0) updates.amount = ...`).
// Se o Go mandar `paidAmount: 0`, o Node deixa de gravar o valor observado pelo
// gateway — que é o número que o Pagar.me diz ter recebido. Este teste existe
// para o `omitempty` não ser "limpeza de estilo" depois.
func TestChargeOmiteAusenteEmVezDeZero(t *testing.T) {
	c := mustMap(t, `{"data":{"id":"or_1","status":"pending"}}`)
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}

	for _, chave := range []string{"paidAmount", "refundedAmount", "pix", "cardLast4", "cardBrand", "providerChargeId", "providerPaymentId"} {
		if _, existe := m[chave]; existe {
			t.Errorf("a chave %q apareceu com valor %v; ausente é o que o Node distingue de zero", chave, m[chave])
		}
	}
	// E o que tem que estar, sempre.
	for _, chave := range []string{"providerOrderId", "status", "amount"} {
		if _, existe := m[chave]; !existe {
			t.Errorf("a chave %q está ausente; sem ela o Node não consegue casar a cobrança", chave)
		}
	}
	// `amount` ausente do gateway é 0 no JSON — que é o que o Node espera
	// (round2(x ?? 0) no mapper dele produz o mesmo).
	if m["amount"] != float64(0) {
		t.Errorf("amount = %v, quer 0", m["amount"])
	}
}

// E com valor presente, a chave aparece com o valor — o outro lado do teste
// acima.
func TestChargeIncluiPresente(t *testing.T) {
	// `refunded_amount` só é lido de `payments[]`, sem plano B no topo — é o
	// `fromCents(payment?.refunded_amount)` do Node (ao contrário de
	// `paid_amount`, que tem `?? order.paid_amount`).
	c := mustMap(t, `{"data":{"id":"ch_1","status":"partially_refunded","paid_amount":1000,"payments":[{"id":"pay_1","refunded_amount":500,"last_transaction":{"card":{"last_four_digits":"1234","brand":"elo"}}}]}}`)

	b, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal falhou: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}

	quer := map[string]any{
		"providerOrderId":   "ch_1",
		"providerChargeId":  "ch_1",
		"providerPaymentId": "pay_1",
		"status":            "partially_refunded",
		"paidAmount":        float64(10),
		"refundedAmount":    float64(5),
		"cardLast4":         "1234",
		"cardBrand":         "elo",
	}
	for chave, esperado := range quer {
		if m[chave] != esperado {
			t.Errorf("%s = %v, quer %v", chave, m[chave], esperado)
		}
	}
}
