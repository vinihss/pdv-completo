package signature

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"strings"
	"testing"
)

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// assina calcula a assinatura do jeito que o Pagar.me calcula
// (`cat postback_body | openssl dgst -sha1 -hmac "<sua api key>"`), ou seja a
// mesma fórmula que o código sob teste usa. Existe para que o teste não seja uma
// tautologia: se a implementação e o teste usassem a mesma linha, um erro
// systematico passaria verde nos dois.
func assina(body []byte, secret string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// -----------------------------------------------------------------------------
// caminho feliz
// -----------------------------------------------------------------------------

func TestVerifyAssinaturaValida(t *testing.T) {
	body := []byte(`{"id":"evt_1","type":"order.paid","data":{"id":"or_1"}}`)
	secret := "sk_test_abc123"

	if !Verify(body, assina(body, secret), secret) {
		t.Fatal("assinatura válida recusada")
	}
}

// -----------------------------------------------------------------------------
// tolerâncias de formato: o que o Node tolera, o Go tolera
// -----------------------------------------------------------------------------

// Caixa alta e baixa no hex, com e sem o prefixo `sha1=`. São as quatro
// combinações que a doc do provedor já mostrou em lugares diferentes, e um
// `false` aqui é um webhook perdido sem erro em log nenhum do lado do
// Pagar.me — que simplesmente para de reenviar depois de desistir.
func TestVerifyToleraCaixaEPrefixo(t *testing.T) {
	body := []byte(`{"id":"evt_1"}`)
	secret := "sk_test_abc123"
	hexBaixo := assina(body, secret)

	casos := []struct {
		nome   string
		header string
	}{
		{"hex minusculo", hexBaixo},
		{"hex MAIUSCULO", strings.ToUpper(hexBaixo)},
		{"prefixo sha1= minusculo", "sha1=" + hexBaixo},
		{"prefixo sha1= MAIUSCULO", "SHA1=" + hexBaixo},
		{"prefixo Sha1= misturado", "Sha1=" + hexBaixo},
		{"hex maiusculo com prefixo", "sha1=" + strings.ToUpper(hexBaixo)},
		{"espaco nas pontas", "  " + hexBaixo + "\t\n"},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			if !Verify(body, c.header, secret) {
				t.Errorf("header %q recusado; o Node aceita o mesmo formato", c.header)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// recusas: o caminho que impede qualquer um de marcar cobrança como paga
// -----------------------------------------------------------------------------

func TestVerifyRecusa(t *testing.T) {
	body := []byte(`{"id":"evt_1","data":{"id":"or_1"}}`)
	secret := "sk_test_abc123"
	valida := assina(body, secret)

	casos := []struct {
		nome   string
		body   []byte
		header string
		secret string
	}{
		// Segredo errado: o caso que este arquivo existe para pegar.
		{"secret key errada", body, valida, "sk_test_OUTRA"},
		{"secret key vazia", body, valida, ""},

		// Header ausente ou vazio.
		{"header ausente", body, "", secret},
		{"header so com espacos", body, "   ", secret},

		// Corpo vazio ou ausente: o Node devolve `false` ANTES de calcular
		// qualquer HMAC (`if (!rawBody ...)`), e o mesmo vale aqui. O corpo
		// vazio não é um payload sem evento: é um request que não se provou.
		{"corpo vazio", []byte{}, valida, secret},
		{"corpo nil", nil, valida, secret},

		// Assinatura de OUTRO corpo: o ataque direto.
		{"assinatura de outro corpo", []byte(`{"id":"evt_2"}`), valida, secret},

		// Formato do header.
		{"prefixo de outro algoritmo", body, "sha256=" + valida, secret},
		{"base64 em vez de hex", body, "kR9x1o0aVQ0m8Vw3h0bQ2vN0kQ0m8Vw3h0bQ2vN0kQ=", secret},
		{"caractere nao-hex", body, valida[:39] + "z" + valida[40:], secret},
		{"so o prefixo sha1=", body, "sha1=", secret},
		{"prefixo no meio", body, "x" + valida, secret},

		// Assinatura truncada: é o caso que quebra `crypto.timingSafeEqual`
		// no Node, que LANÇA com tamanhos diferentes. Aqui o caminho é o regex
		// de 40 caracteres; o teste existe para fixar que o resultado é `false`
		// e NÃO um panic, porque um panic no handler derrubaria a instância
		// inteira — e um 500 no webhook faz o Pagar.me reenviar para sempre.
		{"truncada", body, valida[:len(valida)-1], secret},
		{"truncada ao meio", body, valida[:20], secret},
		{"um caractere a mais", body, valida + "a", secret},
		{"um hex a mais", body, valida + "ab", secret},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			if Verify(c.body, c.header, c.secret) {
				t.Errorf("Verify aceitou: body=%q header=%q secret=%q", c.body, c.header, c.secret)
			}
		})
	}
}

// O caso truncado deserves um teste próprio porque é o único em que o
// comportamento das stdlibs diverge: o Node LANÇA e o Go devolve `false`. Um
// `defer recover` aqui não é paranoia — é a prova de que o handler do webhook
// não pode virar 500 por causa de um header de 39 caracteres.
func TestVerifyTruncadaNaoPanica(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Verify entrou em panic com assinatura truncada: %v", r)
		}
	}()

	body := []byte(`{"id":"evt_1"}`)
	secret := "sk_test_abc123"
	completa := assina(body, secret)

	if Verify(body, completa[:39], secret) {
		t.Fatal("assinatura de 39 caracteres foi aceita")
	}
	if Verify(body, completa+"a", secret) {
		t.Fatal("assinatura de 41 caracteres foi aceita")
	}
}

// -----------------------------------------------------------------------------
// corpo não-ASCII: a HMAC é sobre BYTES
// -----------------------------------------------------------------------------

// O Node calcula a HMAC sobre a STRING (que o Fastify decodificou de UTF-8). Se
// o corpo cru não for UTF-8 válido, o Node teria convertido com U+FFFD e a
// assinatura bateria contra outra coisa — por isso `internal/server` recusa
// corpo que não é UTF-8 antes de chegar aqui. Este teste fixa a paridade com o
// caminho válido: acentuação vai como os bytes certos.
func TestVerifyCorpoComAcentos(t *testing.T) {
	body := []byte(`{"customer":{"name":"José Ãç"}}`)
	secret := "sk_test_abc123"

	if !Verify(body, assina(body, secret), secret) {
		t.Fatal("corpo com acento foi recusado com assinatura correta")
	}
	// A assinatura do MESMO texto sem acento não pode valer: é outro corpo.
	if Verify(body, assina([]byte(`{"customer":{"name":"Jose Ac"}}`), secret), secret) {
		t.Fatal("assinatura de outro texto com o mesmo número de caracteres foi aceita")
	}
}

// Corpos não-ASCII não podem dar o que o Node daria, mas nenhum pode fazer
// `Verify` aceitar. Qualquer entrada que não assine continua recusada.
func TestVerifyNaoPanicaComBytesArbitrarios(t *testing.T) {
	secret := "s"
	corpos := [][]byte{
		{0xff, 0xfe, 0x00},
		{0xc3},
		[]byte("\x00\x00\x00\x00"),
	}

	for _, body := range corpos {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic com body=%v: %v", body, r)
				}
			}()
			if Verify(body, assina(body, secret), secret) != true {
				// Assinatura calculada sobre os mesmos bytes: tem que passar.
				t.Errorf("Verify recusou assinatura válida de body=%v", body)
			}
		}()
	}
}

// -----------------------------------------------------------------------------
// O segredo é usado como chave da HMAC, não como texto comparado
// -----------------------------------------------------------------------------

// A assinatura não pode "passar" por acaso: trocar o segredo troca a assinatura,
// e comparar o header com algo derivado do segredo em vez de computar a HMAC
// daria um caminho de bypass trivial.
func TestVerifyUsaOSegredoComoChaveDaHMAC(t *testing.T) {
	body := []byte(`{"id":"evt_1"}`)

	if Verify(body, assina(body, "sk_a"), "sk_b") {
		t.Fatal("assinação de um segredo valeu para outro")
	}
	if Verify(body, hex.EncodeToString([]byte("0123456789abcdef0123456789abcdef01234567")), "sk_a") {
		t.Fatal("header sem relação com a HMAC foi aceito")
	}
}

// `headerSHA1Length` é a única fonte do 40 no código, e o Node tem o mesmo 40
// no regex. Se alguém mudar o digest e esquecer deste número, o `Verify` passa a
// recusar tudo em silêncio — o pior modo de falha para um webhook.
func TestHeaderSHA1LengthEDigests(t *testing.T) {
	body := []byte("qualquer")
	secret := "s"

	if got := headerSHA1Length; got != 40 {
		t.Fatalf("headerSHA1Length = %d, quer 40 (20 bytes de SHA-1 em hex)", got)
	}
	if n := len(assina(body, secret)); n != headerSHA1Length {
		t.Fatalf("a assinatura produzida tem %d caracteres e o verificador exige %d", n, headerSHA1Length)
	}
}
