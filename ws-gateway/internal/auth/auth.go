// Package auth valida o JWT do backend Node.js no handshake do WebSocket.
//
// O gateway NÃO emite token: ele confere o mesmo token que o backend emite no
// login (`login.usecase.ts`), com o mesmo `JWT_SECRET`. Uma assinatura
// diferente aqui significaria que o client teria que fazer login duas vezes —
// o token do REST não valeria no realtime, que é justamente o caminho que o
// frontend usa (`useRealtime(token, …)` com o token do login).
package auth

import (
	"errors"
	"log"
	"net/http"
	"strings"

	jwt "github.com/golang-jwt/jwt/v5"
)

// ErrUnauthorized é o único erro que sai daqui para fora. O motivo concreto
// (token expirado, assinatura inválida, subprotocol ausente) fica no log: um
// cliente não deve conseguir distinguir "token expirado" de "token de outro
// store" sondando o handshake.
var ErrUnauthorized = errors.New("unauthorized")

// Claims espelha o payload que o Node assina (login.usecase.ts):
// `{ sub, role, storeId?, storeSlug? }` + `exp` de 12h.
//
// `sub` NÃO é campo próprio aqui: RegisteredClaims já traz `Subject` com a tag
// `json:"sub"`. Declarar outro `UserID string` com a MESMA tag criaria dois
// campos `sub` no payload — o encoding/json resolve conflito por profundidade e
// o perdedor some em silêncio, que é o tipo de bug que só aparece em produção.
type Claims struct {
	jwt.RegisteredClaims
	Role      string `json:"role"`
	StoreID   string `json:"storeId,omitempty"`
	StoreSlug string `json:"storeSlug,omitempty"`
}

// User é a identidade autenticada do websocket.
type User struct {
	ID   string
	Role string
}

// Roles que o backend emite (ver Role em auth.middleware.ts). Serve só para
// log: um papel fora daqui não é rejeitado, porque o Node também não rejeita e
// divergir aqui derrubaria conexões que funcionam lá.
var knownRoles = map[string]bool{
	"waiter": true, "kitchen": true, "manager": true, "cashier": true, "courier": true,
}

// Verify confere o token e devolve a identidade. `secret` tem que ser
// byte-a-byte o mesmo `JWT_SECRET` do backend.
func Verify(token, secret string) (*User, error) {
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
		// HS256 exato, e não "algum HMAC". O Node assina com o default do
		// jsonwebtoken (HS256); aceitar a família toda não aumenta o poder de
		// forjar nada (sem a secret não há HMAC nenhum), mas aceitar `alg:none`
		// ou uma chave pública como HMAC seria o classic algorithm-confusion.
		// Fixar o método é uma linha e fecha a classe inteira.
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok || t.Method.Alg() != "HS256" {
			return nil, ErrUnauthorized
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	if !parsed.Valid || claims.Subject == "" || claims.Role == "" {
		return nil, ErrUnauthorized
	}

	if !knownRoles[claims.Role] {
		// Não bloqueia (paridade com o Node, que aceitaria), mas fica visível:
		// um papel inventado num token é sinal de token emitido errado.
		log.Printf("[auth] papel desconhecido no token: %q (sub=%s)", claims.Role, claims.Subject)
	}

	return &User{ID: claims.Subject, Role: claims.Role}, nil
}

// TokenFromHandshake extrai o token do header `Sec-WebSocket-Protocol`.
//
// O token vai por SUBPROTOCOL e não na query string: query string vaza em log
// de proxy, em `Referer` e no histórico. O client faz `new WebSocket(url, [token])`.
//
// O Node pega o primeiro offered e recusa o resto (`offered.split(",")[0]`);
// o gateway faz o mesmo. Emite-se de volta o MESMO token como protocolo escolhido
// no handshake — o navegador exige que o servidor escolha um dos offered, e
// falhar essa escolha derruba a conexão no cliente (Regra: se o servidor não
// selecionar nenhum dos protocolos oferecidos, o client falha).
func TokenFromHandshake(r *http.Request) string {
	offered := r.Header.Get("Sec-WebSocket-Protocol")
	if offered == "" {
		return ""
	}
	return strings.TrimSpace(strings.Split(offered, ",")[0])
}

// Tolerance de `exp` é zero, o default do jsonwebtoken (que é o que o backend
// usa): dar tolerância aqui rejeitaria token que o REST aceita, ou pior,
// aceitaria token que o REST rejeita — e é o mesmo token que passa pelos dois
// caminhos.
