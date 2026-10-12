package config

import (
	"os"
	"testing"
)

// clearEnv remove todas as variáveis lidas por Load, para que um teste não
// herde o ambiente de quem roda a suíte. t.Setenv já restaura no fim; aqui só
// garantimos o ponto de partida limpo.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"PDV_ADMIN_TOKEN", "PDV_ADMIN_ADDR", "PDV_DATABASE_URL", "PDV_REDIS_URL",
		"PDV_BACKEND_CONTAINER", "PDV_DEPLOY_DIR", "PDV_ADMIN_RATE_PER_MIN", "GIT_SHA",
	} {
		t.Setenv(key, "")
		_ = os.Unsetenv(key)
	}
}

func TestLoadSemToken(t *testing.T) {
	clearEnv(t)
	t.Setenv("PDV_DATABASE_URL", "postgres://localhost/pdv")

	if _, err := Load(); err == nil {
		t.Fatal("Load aceitou configuração sem PDV_ADMIN_TOKEN")
	}
}

func TestLoadSemDatabaseURL(t *testing.T) {
	clearEnv(t)
	t.Setenv("PDV_ADMIN_TOKEN", "segredo")

	if _, err := Load(); err == nil {
		t.Fatal("Load aceitou configuração sem PDV_DATABASE_URL")
	}
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	t.Setenv("PDV_ADMIN_TOKEN", "segredo")
	t.Setenv("PDV_DATABASE_URL", "postgres://localhost/pdv")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load falhou: %v", err)
	}
	if cfg.Addr != DefaultAddr {
		t.Errorf("Addr = %q, quer %q", cfg.Addr, DefaultAddr)
	}
	if cfg.RedisURL != DefaultRedisURL {
		t.Errorf("RedisURL = %q, quer %q", cfg.RedisURL, DefaultRedisURL)
	}
	if cfg.BackendContainer != DefaultBackendContainer {
		t.Errorf("BackendContainer = %q, quer %q", cfg.BackendContainer, DefaultBackendContainer)
	}
	if cfg.RatePerMin != DefaultRatePerMin {
		t.Errorf("RatePerMin = %d, quer %d", cfg.RatePerMin, DefaultRatePerMin)
	}
	if cfg.DeployDir != "" {
		t.Errorf("DeployDir = %q, quer vazio", cfg.DeployDir)
	}
	if cfg.Version != "dev" {
		t.Errorf("Version = %q, quer \"dev\"", cfg.Version)
	}
}

func TestLoadOverrides(t *testing.T) {
	clearEnv(t)
	t.Setenv("PDV_ADMIN_TOKEN", "segredo")
	t.Setenv("PDV_DATABASE_URL", "postgres://localhost/pdv")
	t.Setenv("PDV_ADMIN_ADDR", "0.0.0.0:1234")
	t.Setenv("PDV_REDIS_URL", "redis://redis:6379/2")
	t.Setenv("PDV_BACKEND_CONTAINER", "backend")
	t.Setenv("PDV_DEPLOY_DIR", "/opt/pdv/deploy")
	t.Setenv("PDV_ADMIN_RATE_PER_MIN", "30")
	t.Setenv("GIT_SHA", "abc123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load falhou: %v", err)
	}
	if cfg.Addr != "0.0.0.0:1234" || cfg.RedisURL != "redis://redis:6379/2" ||
		cfg.BackendContainer != "backend" || cfg.DeployDir != "/opt/pdv/deploy" ||
		cfg.RatePerMin != 30 || cfg.Version != "abc123" {
		t.Errorf("overrides não aplicados: %+v", cfg)
	}
}

func TestLoadRateInvalido(t *testing.T) {
	clearEnv(t)
	t.Setenv("PDV_ADMIN_TOKEN", "segredo")
	t.Setenv("PDV_DATABASE_URL", "postgres://localhost/pdv")
	t.Setenv("PDV_ADMIN_RATE_PER_MIN", "zero")

	if _, err := Load(); err == nil {
		t.Fatal("Load aceitou PDV_ADMIN_RATE_PER_MIN inválido")
	}
}
