// Package signature valida o header `X-Hub-Signature` do webhook do Pagar.me.
//
// ## O que éportado
//
// `verifyWebhookSignature` de
// `backend/src/integrations/pagarme/webhook-signature.ts:28`, com paridade de
// decisão — não só de resultado. Os três detalhes que o Node trata e que aqui
// continuam tratados:
//
//   - tolera o prefixo `sha1=` (convenção do `X-Hub-Signature` do GitHub, que o
//     Pagar.me também usa em parte da documentação) e hex em caixa alta ou
//     baixa;
//   - exige `^[0-9a-f]{40}$` ANTES de comparar, o que descarta lixo de base64,
//     string truncada e qualquer coisa que não seja exatamente um SHA-1 em hex;
//   - compara em tempo constante.
//
// ## Por que SHA-1 e não SHA-256
//
// É o esquema do Pagar.me. Não é escolha nossa e inventar um esquema melhor que
// o do provedor faria o webhook simplesmente nunca validar. SHA-1 está quebrado
// para colisão, o que não é a ameaça aqui: quem forjaria uma assinatura válida
// sem a key continua sem a key. A função fica isolada neste arquivo justamente
// para ser trocada sem tocar em rotas nem em cliente.
package signature

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // SHA-1 é o esquema do Pagar.me, não escolha nossa (ver acima)
	"strings"
)

// headerSHA1Length é o tamanho de um SHA-1 em hex: 20 bytes, 40 caracteres.
// Vem do `^[0-9a-f]{40}$` do Node, e é o que garante que `hmac.Equal` receba
// dois slices do mesmo tamanho.
const headerSHA1Length = sha1.Size * 2

// hexLower é o conjunto que o regex do Node aceita. Compilar a regex da stdlib
// por chamada seria desperdício; o conjunto serve a mesma checagem e a validação
// de byte a byte é mais fácil de ler.
var hexLower = func(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f')
}

// Verify confere a assinatura do corpo CRU contra a secret key.
//
// `rawBody` são os BYTES recebidos, não uma string já re-serializada: a HMAC é
// calculada sobre o que o gateway mandou, e parse/re-stringify muda espaçamento
// e ordem de chave. No Node isso exigia um content type parser customizado para
// preservar `req.rawBody` (http/server.ts:79); o `http.Server` do Go entrega o
// corpo bruto naturalmente, e o chamador tem a obrigação de passá-lo antes de
// qualquer `json.Unmarshal` (ver internal/server).
//
// Devolve `false` — nunca erro — para qualquer recusa: corpo vazio, header
// ausente, secret key ausente, formato inesperado ou assinatura diferente. Quem
// chama só precisa do booleano, e um caminho de erro aqui viraria uma segunda
// fonte de resposta HTTP para a mesma condição.
func Verify(rawBody []byte, signatureHeader string, secretKey string) bool {
	// Mesma guarda do Node: `if (!rawBody || !signatureHeader || !secretKey)`.
	// Sem secret key não há o que calcular, e o chamador tem de tratar isso
	// como "não configurado" (503) antes de chegar aqui — ver internal/server.
	if len(rawBody) == 0 || signatureHeader == "" || secretKey == "" {
		return false
	}

	provided, ok := normalize(signatureHeader)
	if !ok {
		return false
	}

	mac := hmac.New(sha1.New, []byte(secretKey))
	// `Write` nunca devolve erro: hash.Hash sempre engole o que recebe.
	_, _ = mac.Write(rawBody)
	expected := mac.Sum(nil)

	// Guarda de comprimento antes da comparação. No Node ela é obrigatória
	// porque `crypto.timingSafeEqual` LANÇA com tamanhos diferentes; em Go o
	// `hmac.Equal` (que é `subtle.ConstantTimeCompare`) devolve `false` sem
	// lançar, então a guarda é redundante em segurança — mas fica pelo mesmo
	// motivo do Node: o comprimento do hex é público (40 caracteres por
	// definição), então compará-lo não vaza nada, e o código fica com a
	// paridade explícita em vez de depender de um detalhe da stdlib.
	if len(provided) != len(expected) {
		return false
	}
	return hmac.Equal(expected, provided)
}

// normalize devolve os bytes crus do hex informado, em minúscula.
//
// Aceita o prefixo `sha1=` (qualquer caixa) e qualquer caixa do hex, que é o
// que o `trim().replace(/^sha1=/i, "").toLowerCase()` do Node faz. Devolve
// `ok=false` para o que não casar com `^[0-9a-f]{40}$` depois da limpeza —
// incluindo tamanho errado, caractere inválido e o hex de prefixo duplicado.
func normalize(header string) ([]byte, bool) {
	h := strings.TrimSpace(header)
	// `sha1=` só é removido no INÍCIO, como a âncora `^` do Node garante. Um
	// `X-Hub-Signature: sha256=abc...sha1=<40 hex>` não é normalizado: a
	// validação do tamanho rejecta, e um header que tem o prefixo no meio é
	// lixo, não um formato tolerado.
	if len(h) >= len("sha1=") && strings.EqualFold(h[:len("sha1=")], "sha1=") {
		h = h[len("sha1="):]
	}
	if len(h) != headerSHA1Length {
		return nil, false
	}

	raw := make([]byte, headerSHA1Length/2)
	for i := 0; i < len(h); i++ {
		c := h[i]
		// `ToLower` do Node: ASCII maiúsculo e minúsculo, e nada mais.
		if c >= 'A' && c <= 'F' {
			c += 'a' - 'A'
		}
		if !hexLower(c) {
			return nil, false
		}
		if i%2 == 0 {
			raw[i/2] = hexDigit(c) << 4
		} else {
			raw[i/2] |= hexDigit(c)
		}
	}
	return raw, true
}

// hexDigit converte um caractere hex já validado em seu valor. O chamador já
// passou por `hexLower`, então não há como dar ruim aqui.
func hexDigit(c byte) byte {
	if c <= '9' {
		return c - '0'
	}
	return c - 'a' + 10
}
