package tui

import (
	"context"
	"fmt"

	"pdv-cli/internal/ops"
	"pdv-cli/internal/remote"
)

// Backend abstrai as operações de administração usadas pela TUI, permitindo
// operar um admin-server remoto ou o clone local sem que as telas saibam a
// diferença.
type Backend interface {
	Label() string
	IsRemote() bool
	ListTenants() ([]Tenant, error)
	CreateTenant(slug, displayName string) (pin string, err error)
	RenameTenant(slug, displayName string) error
	SetTenantStatus(slug, status string) error
	GetSettings(slug string) (*StoreConfig, error)
	UpdateSettings(slug string, patch map[string]any) error
	ClearCache() error
	Backup(target string) ([]string, error)
}

// remoteAPI é o subconjunto de *remote.Client que o remoteBackend usa. Existe
// para que os testes possam injetar um fake sem subir um servidor HTTP.
type remoteAPI interface {
	ListTenants(ctx context.Context) ([]remote.Tenant, error)
	CreateTenant(ctx context.Context, slug, displayName string) (remote.Tenant, string, error)
	RenameTenant(ctx context.Context, slug, displayName string) (remote.Tenant, error)
	SetTenantStatus(ctx context.Context, slug, status string) (remote.Tenant, error)
	GetSettings(ctx context.Context, slug string) (map[string]any, error)
	UpdateSettings(ctx context.Context, slug string, patch map[string]any) (map[string]any, error)
	ClearCache(ctx context.Context) error
	Backup(ctx context.Context, target string) ([]string, error)
	BaseURL() string
}

// ============================================================
// BACKEND REMOTO
// ============================================================

// remoteBackend opera um admin-server via HTTP.
type remoteBackend struct {
	label  string
	client remoteAPI
}

// newRemoteBackend cria um backend remoto com o nome do servidor como label.
func newRemoteBackend(label string, client remoteAPI) *remoteBackend {
	return &remoteBackend{label: label, client: client}
}

func (b *remoteBackend) Label() string  { return b.label }
func (b *remoteBackend) IsRemote() bool { return true }

func (b *remoteBackend) ListTenants() ([]Tenant, error) {
	remotes, err := b.client.ListTenants(context.Background())
	if err != nil {
		return nil, err
	}
	converted := make([]Tenant, len(remotes))
	for i, t := range remotes {
		converted[i] = tenantFromRemote(t)
	}
	return converted, nil
}

func (b *remoteBackend) CreateTenant(slug, displayName string) (string, error) {
	_, pin, err := b.client.CreateTenant(context.Background(), slug, displayName)
	return pin, err
}

func (b *remoteBackend) RenameTenant(slug, displayName string) error {
	_, err := b.client.RenameTenant(context.Background(), slug, displayName)
	return err
}

func (b *remoteBackend) SetTenantStatus(slug, status string) error {
	_, err := b.client.SetTenantStatus(context.Background(), slug, status)
	return err
}

func (b *remoteBackend) GetSettings(slug string) (*StoreConfig, error) {
	settings, err := b.client.GetSettings(context.Background(), slug)
	if err != nil {
		return nil, err
	}
	return settingsToStoreConfig(settings), nil
}

func (b *remoteBackend) UpdateSettings(slug string, patch map[string]any) error {
	_, err := b.client.UpdateSettings(context.Background(), slug, patch)
	return err
}

func (b *remoteBackend) ClearCache() error {
	return b.client.ClearCache(context.Background())
}

func (b *remoteBackend) Backup(target string) ([]string, error) {
	return b.client.Backup(context.Background(), target)
}

// ============================================================
// BACKEND LOCAL
// ============================================================

// localBackend opera o clone local do repo via internal/ops.
type localBackend struct {
	slug string
}

// newLocalBackend cria um backend local.
func newLocalBackend() *localBackend {
	return &localBackend{}
}

// SelectTenant associa o tenant selecionado ao backend local (o dump é por
// schema e por isso precisa do slug). Backends remotos são globais.
func (b *localBackend) SelectTenant(slug string) {
	b.slug = slug
}

// tenantSelector é implementado por backends cujo Backup depende do tenant
// selecionado (modo local).
type tenantSelector interface {
	SelectTenant(slug string)
}

func (b *localBackend) Label() string  { return "local" }
func (b *localBackend) IsRemote() bool { return false }

func (b *localBackend) ListTenants() ([]Tenant, error) {
	tenants, err := ops.ListTenants()
	if err != nil {
		return nil, err
	}
	converted := make([]Tenant, len(tenants))
	for i, t := range tenants {
		converted[i] = Tenant{
			ID:        t.ID,
			Slug:      t.Slug,
			Name:      t.Subdomain,
			Status:    t.Status,
			Subdomain: t.Subdomain,
			CreatedAt: t.CreatedAt,
		}
	}
	return converted, nil
}

func (b *localBackend) CreateTenant(slug, displayName string) (string, error) {
	if err := ops.CreateTenant(slug, displayName); err != nil {
		return "", err
	}
	return "", nil
}

func (b *localBackend) RenameTenant(slug, displayName string) error {
	return fmt.Errorf("renomear tenant não é suportado no modo local")
}

func (b *localBackend) SetTenantStatus(slug, status string) error {
	switch status {
	case "active":
		return ops.ReactivateTenant(slug)
	case "suspended":
		return ops.SuspendTenant(slug)
	default:
		return fmt.Errorf("status inválido: %s", status)
	}
}

func (b *localBackend) GetSettings(slug string) (*StoreConfig, error) {
	// ops.GetStoreConfig consulta uma coluna `settings` (JSONB) que não existe
	// em store_settings (tabela de colunas fixas) — bug pré-existente do modo
	// local. Enquanto não for corrigido, não expõe um caminho quebrado.
	return nil, fmt.Errorf("editar configurações não é suportado no modo local")
}

func (b *localBackend) UpdateSettings(slug string, patch map[string]any) error {
	// Mesmo motivo de GetSettings: ops.UpdateStoreConfig escreve na coluna
	// `settings`, que não existe. O modo local mantém o comportamento anterior
	// (não implementado) em vez de chamar código quebrado.
	return fmt.Errorf("editar configurações não é suportado no modo local")
}

func (b *localBackend) ClearCache() error {
	return fmt.Errorf("limpar cache não é suportado no modo local")
}

func (b *localBackend) Backup(target string) ([]string, error) {
	if target != "db" {
		return nil, fmt.Errorf("backup de arquivos não é suportado no modo local")
	}
	if b.slug == "" {
		return nil, fmt.Errorf("nenhum tenant selecionado para backup")
	}
	outputFile := fmt.Sprintf("/tmp/tenant-%s-dump.sql", b.slug)
	if err := ops.DumpTenant(b.slug, outputFile); err != nil {
		return nil, err
	}
	return []string{outputFile}, nil
}

// ============================================================
// HELPERS DE MAPEAMENTO
// ============================================================

// tenantFromRemote converte um tenant do admin-server para o tipo da TUI.
func tenantFromRemote(t remote.Tenant) Tenant {
	subdomain := ""
	if t.CustomDomain != nil {
		subdomain = *t.CustomDomain
	}
	return Tenant{
		Slug:      t.Slug,
		Name:      t.DisplayName,
		Status:    t.Status,
		Subdomain: subdomain,
		CreatedAt: t.CreatedAt,
	}
}

// settingsToStoreConfig converte o mapa de settings do admin-server para o
// StoreConfig da TUI.
func settingsToStoreConfig(settings map[string]any) *StoreConfig {
	cfg := &StoreConfig{}
	if settings == nil {
		return cfg
	}
	if v, ok := settings["merchant_name"].(string); ok {
		cfg.MerchantName = v
	}
	cfg.PrintEnabled = boolFromAny(settings["printer_enabled"])
	cfg.AutoPrint = boolFromAny(settings["printer_auto_print"])
	cfg.DeliveryEnabled = boolFromAny(settings["uses_delivery"])
	return cfg
}

// storeConfigPatch monta o patch (colunas de store_settings) a partir do
// StoreConfig.
func storeConfigPatch(cfg *StoreConfig) map[string]any {
	if cfg == nil {
		cfg = &StoreConfig{}
	}
	return map[string]any{
		"merchant_name":      cfg.MerchantName,
		"printer_enabled":    cfg.PrintEnabled,
		"printer_auto_print": cfg.AutoPrint,
		"uses_delivery":      cfg.DeliveryEnabled,
	}
}

func boolFromAny(v any) bool {
	b, _ := v.(bool)
	return b
}
