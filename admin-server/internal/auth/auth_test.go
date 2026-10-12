package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
}

func do(t *testing.T, h http.Handler, remoteAddr, authHeader string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/admin/tenants", nil)
	r.RemoteAddr = remoteAddr
	if authHeader != "" {
		r.Header.Set("Authorization", authHeader)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestSemTokenRetorna401(t *testing.T) {
	h := Middleware("segredo", 100, 100, okHandler())
	if got := do(t, h, "10.0.0.1:1234", "").Code; got != http.StatusUnauthorized {
		t.Fatalf("sem token: status %d, quer 401", got)
	}
}

func TestTokenErradoRetorna401(t *testing.T) {
	h := Middleware("segredo", 100, 100, okHandler())
	if got := do(t, h, "10.0.0.1:1234", "Bearer outro").Code; got != http.StatusUnauthorized {
		t.Fatalf("token errado: status %d, quer 401", got)
	}
}

func TestEsquemaErradoRetorna401(t *testing.T) {
	h := Middleware("segredo", 100, 100, okHandler())
	if got := do(t, h, "10.0.0.1:1234", "Basic segredo").Code; got != http.StatusUnauthorized {
		t.Fatalf("esquema errado: status %d, quer 401", got)
	}
}

func TestTokenCorretoRetorna200(t *testing.T) {
	h := Middleware("segredo", 100, 100, okHandler())
	if got := do(t, h, "10.0.0.1:1234", "Bearer segredo").Code; got != http.StatusOK {
		t.Fatalf("token correto: status %d, quer 200", got)
	}
}

func TestRateLimitRetorna429(t *testing.T) {
	// 1 rps com burst 1: a segunda requisição imediata estoura.
	h := Middleware("segredo", 1, 1, okHandler())

	if got := do(t, h, "10.0.0.1:1234", "Bearer segredo").Code; got != http.StatusOK {
		t.Fatalf("primeira requisição: status %d, quer 200", got)
	}
	if got := do(t, h, "10.0.0.1:1234", "Bearer segredo").Code; got != http.StatusTooManyRequests {
		t.Fatalf("segunda requisição: status %d, quer 429", got)
	}
}

// O limite é por IP: o estouro de um não pode derrubar o outro.
func TestRateLimitPorIP(t *testing.T) {
	h := Middleware("segredo", 1, 1, okHandler())

	_ = do(t, h, "10.0.0.1:1234", "Bearer segredo")
	if got := do(t, h, "10.0.0.2:1234", "Bearer segredo").Code; got != http.StatusOK {
		t.Fatalf("outro IP: status %d, quer 200", got)
	}
}

func TestTokenMatches(t *testing.T) {
	if tokenMatches("", "segredo") {
		t.Error("token vazio foi aceito")
	}
	if tokenMatches("segredo", "") {
		t.Error("configuração sem token aceitou requisição")
	}
	if !tokenMatches("segredo", "segredo") {
		t.Error("token igual foi recusado")
	}
	if tokenMatches("segredo!", "segredo") {
		t.Error("token diferente foi aceito")
	}
}
