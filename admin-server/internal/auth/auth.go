// Package auth protege as rotas /admin com um bearer estático e um rate limit
// por IP. É deliberadamente simples: um único token, comparado em tempo
// constante, e um limite por cliente.
//
// O token é estático (decisão de docs/25 §2). Sem TLS ele viaja em claro, então
// o bind padrão é 127.0.0.1 e a exposição externa é responsabilidade do Caddy.
package auth

import (
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// idleTTL é quando um limiter sem uso é descartado. O serviço é de baixo
// tráfego; sem a limpeza o mapa cresceria com todo IP que já bateu na porta,
// para sempre.
const idleTTL = 10 * time.Minute

// cleanupInterval é de quanto em quanto a varredura de limiteres idle roda.
// Oportunística: acontece dentro de allow, no máximo uma vez por intervalo.
const cleanupInterval = time.Minute

// Middleware devolve o handler que exige `Authorization: Bearer <token>` e
// aplica o rate limit por IP antes de chamar next.
//
// rps é o teto sustentado (requisições por segundo) e bus o pico instantâneo.
// O estado dos limiteadores vive no closure, ou seja, enquanto o handler viver
// — que é o tempo do processo.
func Middleware(token string, rps float64, bus int, next http.Handler) http.Handler {
	if bus <= 0 {
		bus = 1
	}
	rl := &ipLimiter{
		limiters: make(map[string]*limiterEntry),
		rps:      rate.Limit(rps),
		burst:    bus,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !tokenMatches(bearerToken(r), token) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "token ausente ou inválido")
			return
		}
		if !rl.allow(clientIP(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "excesso de requisições")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// bearerToken extrai o valor de `Authorization: Bearer <token>`.
func bearerToken(r *http.Request) string {
	raw := r.Header.Get("Authorization")
	if raw == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(raw) < len(prefix) || !strings.EqualFold(raw[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(raw[len(prefix):])
}

// tokenMatches compara em tempo constante. ConstantTimeCompare devolve 0 quando
// os tamanhos diferem, o que também é constante — não vaza o tamanho do token.
func tokenMatches(got, want string) bool {
	if want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// clientIP é a parte host de RemoteAddr. Não confiamos em X-Forwarded-For aqui:
// atrás do Caddy quem fala com o admin-server é o proxy, e usar o header
// permitiria forjar o IP e furar o rate limit.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

type limiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type ipLimiter struct {
	mu          sync.Mutex
	limiters    map[string]*limiterEntry
	rps         rate.Limit
	burst       int
	lastCleanup time.Time
}

func (l *ipLimiter) allow(ip string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	e, ok := l.limiters[ip]
	if !ok {
		e = &limiterEntry{limiter: rate.NewLimiter(l.rps, l.burst)}
		l.limiters[ip] = e
	}
	e.lastSeen = now
	l.cleanupLocked(now)
	return e.limiter.Allow()
}

// cleanupLocked descarta limiteadores ociosos. Com o mutex já tomado.
func (l *ipLimiter) cleanupLocked(now time.Time) {
	if now.Sub(l.lastCleanup) < cleanupInterval {
		return
	}
	l.lastCleanup = now
	for ip, e := range l.limiters {
		if now.Sub(e.lastSeen) > idleTTL {
			delete(l.limiters, ip)
		}
	}
}

func writeError(w http.ResponseWriter, code int, errCode, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": errCode, "message": message},
	})
}
