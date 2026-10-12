package tenants

import (
	"regexp"
	"strings"
)

// pinPattern casa a linha que o seed de produção imprime:
//
//	[seed-prod] Usuário gerente "Gerente" criado — PIN: 1234
//
// O valor é o token não-espaço depois de "PIN:", e a extração final fica só com
// os dígitos — o script pode acrescentar pontuação.
var pinPattern = regexp.MustCompile(`PIN:\s*(\S+)`)

// PinFromOutput extrai o PIN do stdout do provisionamento. Devolve ok=false se
// não houver PIN (o tenant segue criado; o script só pulou o bootstrap).
func PinFromOutput(stdout string) (string, bool) {
	m := pinPattern.FindStringSubmatch(stdout)
	if m == nil {
		return "", false
	}
	var digits strings.Builder
	for _, r := range m[1] {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	if digits.Len() == 0 {
		return "", false
	}
	return digits.String(), true
}
