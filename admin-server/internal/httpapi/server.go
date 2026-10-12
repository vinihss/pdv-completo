// Package httpapi monta a superfície HTTP do admin-server. As rotas usam os
// padrões method+wildcard do net/http (Go 1.22+), sem framework.
//
// As dependências entram por interface definida AQUI (consumer-defined), para
// os handlers serem testáveis com fakes e não conhecerem pgx/redis.
package httpapi

import (
	"context"
	"net/http"
	"time"

	"pdv-admin-server/internal/settings"
	"pdv-admin-server/internal/tenants"
)

// TenantStore é o acesso ao registry `public.tenant`.
type TenantStore interface {
	ListTenants(ctx context.Context) ([]tenants.Tenant, error)
	GetTenant(ctx context.Context, slug string) (tenants.Tenant, bool, error)
	UpdateTenantName(ctx context.Context, slug, displayName string) (tenants.Tenant, bool, error)
	UpdateTenantStatus(ctx context.Context, slug, status string) (tenants.Tenant, bool, error)
}

// SettingsStore lê e altera `tenant_<slug>.store_settings`.
type SettingsStore interface {
	GetSettings(ctx context.Context, slug string) (*settings.StoreSettings, bool, error)
	UpdateSettings(ctx context.Context, slug string, patch *settings.Patch) (*settings.StoreSettings, bool, error)
}

// Provisioner cria um tenant. O PIN volta uma única vez.
type Provisioner interface {
	Provision(ctx context.Context, slug, displayName string) (pin string, err error)
}

// CacheFlusher limpa o Redis (FLUSHDB).
type CacheFlusher interface {
	Flush(ctx context.Context) error
}

// BackupRunner roda o backup e devolve os caminhos produzidos.
type BackupRunner interface {
	Backup(ctx context.Context, target string) (paths []string, err error)
}

// Deps é tudo que os handlers precisam.
type Deps struct {
	Tenants     TenantStore
	Settings    SettingsStore
	Provisioner Provisioner
	Cache       CacheFlusher
	Backup      BackupRunner
	Version     string
	Started     time.Time
}

// Server é o roteador das rotas administrativas. O /health fica fora dele: é
// a única rota sem auth.
type Server struct {
	deps  Deps
	admin *http.ServeMux
}

// New monta a tabela de rotas.
func New(deps Deps) *Server {
	s := &Server{deps: deps}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /admin/tenants", s.handleListTenants)
	mux.HandleFunc("POST /admin/tenants", s.handleCreateTenant)
	mux.HandleFunc("PATCH /admin/tenants/{slug}", s.handleRenameTenant)
	mux.HandleFunc("PATCH /admin/tenants/{slug}/status", s.handleTenantStatus)
	mux.HandleFunc("GET /admin/tenants/{slug}/settings", s.handleGetSettings)
	mux.HandleFunc("PUT /admin/tenants/{slug}/settings", s.handlePutSettings)
	mux.HandleFunc("POST /admin/cache/clear", s.handleCacheClear)
	mux.HandleFunc("POST /admin/backup", s.handleBackup)
	s.admin = mux

	return s
}

// AdminHandler devolve o handler a ser protegido pelo middleware de auth.
func (s *Server) AdminHandler() http.Handler {
	return s.admin
}

// HealthHandler devolve o /health, que NÃO passa por auth (liveness).
func (s *Server) HealthHandler() http.HandlerFunc {
	return s.handleHealth
}
