package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jwt "github.com/golang-jwt/jwt/v5"
)

const secret = "segredo-de-teste-do-pdv"

// sign monta um token como o backend monta (login.usecase.ts): HS256, payload
// {sub, role}, exp de 12h.
func sign(t *testing.T, claims jwt.MapClaims, key any, method jwt.SigningMethod) string {
	t.Helper()
	token, err := jwt.NewWithClaims(method, claims).SignedString(key)
	if err != nil {
		t.Fatalf("não consegui assinar o token de teste: %v", err)
	}
	return token
}

func validClaims() jwt.MapClaims {
	return jwt.MapClaims{
		"sub":  "11111111-1111-1111-1111-111111111111",
		"role": "waiter",
		"exp":  time.Now().Add(12 * time.Hour).Unix(),
		"iat":  time.Now().Unix(),
	}
}

// O caminho feliz: é o token que o login do backend emite, verificado com o
// mesmo segredo. Se este teste quebrar, nenhum client consegue mais conectar no
// realtime — vale mais que os negativos em impacto.
func TestVerifyTokenValido(t *testing.T) {
	user, err := Verify(sign(t, validClaims(), []byte(secret), jwt.SigningMethodHS256), secret)
	if err != nil {
		t.Fatalf("token válido foi recusado: %v", err)
	}
	if user.ID != "11111111-1111-1111-1111-111111111111" {
		t.Errorf("sub errado: %q", user.ID)
	}
	if user.Role != "waiter" {
		t.Errorf("role errada: %q", user.Role)
	}
}

// storeId/storeSlug existem no payload do backend mas não influenceem room. Se
// um dia passarem a contar para autorização, este teste avisa.
func TestVerifyTokenComStore(t *testing.T) {
	claims := validClaims()
	claims["storeId"] = "store-1"
	claims["storeSlug"] = "bar-do-ze"

	user, err := Verify(sign(t, claims, []byte(secret), jwt.SigningMethodHS256), secret)
	if err != nil {
		t.Fatalf("token com store foi recusado: %v", err)
	}
	if user.Role != "waiter" {
		t.Errorf("role errada: %q", user.Role)
	}
}

func TestVerifyRejeita(t *testing.T) {
	expirado := validClaims()
	expirado["exp"] = time.Now().Add(-1 * time.Hour).Unix()

	semSub := validClaims()
	delete(semSub, "sub")

	semRole := validClaims()
	delete(semRole, "role")

	// Token sem `exp` é o que o Node aceita também (jsonwebtoken não exige exp).
	// Aqui segue aceito — divergir rejeitaria um token que o REST aceitou.
	semExp := validClaims()
	delete(semExp, "exp")

	tests := []struct {
		name  string
		token string
		key   string
	}{
		{"segredo errado", sign(t, validClaims(), []byte("outro-segredo"), jwt.SigningMethodHS256), secret},
		{"token expirado", sign(t, expirado, []byte(secret), jwt.SigningMethodHS256), secret},
		{"token sem sub", sign(t, semSub, []byte(secret), jwt.SigningMethodHS256), secret},
		{"token sem role", sign(t, semRole, []byte(secret), jwt.SigningMethodHS256), secret},
		{"alg none", sign(t, validClaims(), jwt.UnsafeAllowNoneSignatureType, jwt.SigningMethodNone), secret},
		{"HS384 em vez de HS256", sign(t, validClaims(), []byte(secret), jwt.SigningMethodHS384), secret},
		{"HS512 em vez de HS256", sign(t, validClaims(), []byte(secret), jwt.SigningMethodHS512), secret},
		{"token vazio", "", secret},
		{"lixo", "não-é-um-jwt", secret},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Verify(tt.token, tt.key); err == nil {
				t.Error("token inválido foi aceito — o gateway aceitaria sessão falsa")
			}
		})
	}
}

// O ataque clássico: um atacante assina com a chave pública e torce o header
// para que o servidor a trate como segredo HMAC. Se o keyfunc devolvesse a
// public key sem checar o método, este token passaria. Aqui tem que falhar.
func TestVerifyRejeitaConfusaoDeAlgoritmo(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("não consegui gerar a chave RSA: %v", err)
	}

	token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, validClaims()).SignedString(key)
	if err != nil {
		t.Fatalf("não consegui assinar com RSA: %v", err)
	}

	if _, err := Verify(token, secret); err == nil {
		t.Fatal("token RS256 aceito como se fosse HMAC — confusão de algoritmo")
	}
}

// Tolerância de relógio zero, como o jsonwebtoken. Com tolerância, um token
// expirado por alguns segundos entraria no realtime mas seria rejeitado pelo
// REST — o mesmo token dando respostas diferentes nos dois caminhos.
func TestVerifySemToleranciaDeRelogio(t *testing.T) {
	quaseExpirado := validClaims()
	quaseExpirado["exp"] = time.Now().Add(-2 * time.Second).Unix()

	if _, err := Verify(sign(t, quaseExpirado, []byte(secret), jwt.SigningMethodHS256), secret); err == nil {
		t.Error("token expirado há 2s foi aceito; o Node rejeitaria")
	}
}

// O token vem por subprotocol, nunca na query string (que vaza em log de
// proxy). O Node pega o primeiro offered; o gateway tem que pegar o mesmo.
func TestTokenFromHandshake(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
	}{
		{"token único", "abc.def.ghi", "abc.def.ghi"},
		{"com espaços", "  abc.def.ghi  ", "abc.def.ghi"},
		{"vários Offered", "primeiro,segundo", "primeiro"},
		{"vários com espaço", " primeiro , segundo ", "primeiro"},
		{"sem header", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/realtime", nil)
			if tt.header != "" {
				r.Header.Set("Sec-WebSocket-Protocol", tt.header)
			}
			if got := TokenFromHandshake(r); got != tt.want {
				t.Errorf("TokenFromHandshake() = %q, quer %q", got, tt.want)
			}
		})
	}
}

// O token NÃO pode vir da query string, mesmo que o cliente mande lá. Sem este
// teste, alguém "facilita" a vida aceitando os dois e o token passa a vazar em
// access log do Caddy e do proxy.
func TestTokenNaoVemDaQueryString(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/realtime?token=abc.def.ghi", nil)
	if got := TokenFromHandshake(r); got != "" {
		t.Errorf("token veio da query string: %q — isso vaza em log de proxy", got)
	}
}
