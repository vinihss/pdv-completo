// Package config carrega a configuração do admin-server a partir do ambiente.
//
// O token e a URL do banco são obrigatórios: sem token o serviço aceitaria
// qualquer requisição, e sem banco ele não teria o que administrar. Falhar no
// boot é melhor do que subir um serviço que responde 500 em tudo.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Defaults de configuração. Ficam como constantes para o teste poder afirmar
// que os defaults foram aplicados sem reescrever strings soltas.
const (
	DefaultAddr             = "127.0.0.1:9090"
	DefaultRedisURL         = "redis://127.0.0.1:6379"
	DefaultBackendContainer = "deploy-backend-1"
	DefaultRatePerMin       = 120
)

// Config é a configuração resolvida do processo.
type Config struct {
	// Token é o bearer estático esperado em `Authorization`. Obrigatório.
	Token string
	// Addr é o endereço de bind. Default 127.0.0.1:9090 (só a máquina local).
	Addr string
	// DatabaseURL é o DSN do Postgres. Obrigatório.
	DatabaseURL string
	// RedisURL é o DSN do Redis usado por /admin/cache/clear.
	RedisURL string
	// BackendContainer é o container onde o provisioning roda via docker exec.
	BackendContainer string
	// DeployDir é o diretório que contém backup.sh. Vazio desabilita o backup.
	DeployDir string
	// RatePerMin é o teto de requisições por minuto por IP.
	RatePerMin int
	// Version identifica o build no /health (GIT_SHA ou "dev").
	Version string
}

// Load lê o ambiente e devolve a configuração. Devolve erro se um obrigatório
// estiver ausente ou se um valor numérico for inválido.
func Load() (*Config, error) {
	token := strings.TrimSpace(os.Getenv("PDV_ADMIN_TOKEN"))
	if token == "" {
		return nil, fmt.Errorf("PDV_ADMIN_TOKEN é obrigatório")
	}

	databaseURL := strings.TrimSpace(os.Getenv("PDV_DATABASE_URL"))
	if databaseURL == "" {
		return nil, fmt.Errorf("PDV_DATABASE_URL é obrigatório")
	}

	ratePerMin := DefaultRatePerMin
	if raw := strings.TrimSpace(os.Getenv("PDV_ADMIN_RATE_PER_MIN")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("PDV_ADMIN_RATE_PER_MIN inválido: %q", raw)
		}
		ratePerMin = n
	}

	return &Config{
		Token:            token,
		Addr:             envOr("PDV_ADMIN_ADDR", DefaultAddr),
		DatabaseURL:      databaseURL,
		RedisURL:         envOr("PDV_REDIS_URL", DefaultRedisURL),
		BackendContainer: envOr("PDV_BACKEND_CONTAINER", DefaultBackendContainer),
		DeployDir:        strings.TrimSpace(os.Getenv("PDV_DEPLOY_DIR")),
		RatePerMin:       ratePerMin,
		Version:          envOr("GIT_SHA", "dev"),
	}, nil
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
