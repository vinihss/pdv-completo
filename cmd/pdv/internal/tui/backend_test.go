package tui

import (
	"context"
	"strings"
	"testing"

	"pdv-cli/internal/remote"
)

// fakeRemoteAPI implementa remoteAPI para os testes, sem HTTP.
type fakeRemoteAPI struct {
	tenants     []remote.Tenant
	listErr     error
	createPIN   string
	createErr   error
	renameErr   error
	statusErr   error
	settings    map[string]any
	getErr      error
	updateErr   error
	clearErr    error
	backupPaths []string
	backupErr   error

	lastPatch  map[string]any
	lastBackup string
	lastRename string
	lastStatus string
}

func (f *fakeRemoteAPI) ListTenants(context.Context) ([]remote.Tenant, error) {
	return f.tenants, f.listErr
}

func (f *fakeRemoteAPI) CreateTenant(context.Context, string, string) (remote.Tenant, string, error) {
	return remote.Tenant{}, f.createPIN, f.createErr
}

func (f *fakeRemoteAPI) RenameTenant(_ context.Context, slug, displayName string) (remote.Tenant, error) {
	f.lastRename = slug + "=" + displayName
	return remote.Tenant{}, f.renameErr
}

func (f *fakeRemoteAPI) SetTenantStatus(_ context.Context, slug, status string) (remote.Tenant, error) {
	f.lastStatus = slug + ":" + status
	return remote.Tenant{}, f.statusErr
}

func (f *fakeRemoteAPI) GetSettings(context.Context, string) (map[string]any, error) {
	return f.settings, f.getErr
}

func (f *fakeRemoteAPI) UpdateSettings(_ context.Context, _ string, patch map[string]any) (map[string]any, error) {
	f.lastPatch = patch
	return patch, f.updateErr
}

func (f *fakeRemoteAPI) ClearCache(context.Context) error { return f.clearErr }

func (f *fakeRemoteAPI) Backup(_ context.Context, target string) ([]string, error) {
	f.lastBackup = target
	return f.backupPaths, f.backupErr
}

func (f *fakeRemoteAPI) BaseURL() string { return "http://fake" }

func TestRemoteBackendListTenantsMapping(t *testing.T) {
	domain := "loja.exemplo.com"
	api := &fakeRemoteAPI{tenants: []remote.Tenant{
		{Slug: "a", DisplayName: "Loja A", Status: "active", CreatedAt: "2026-01-01", CustomDomain: &domain},
		{Slug: "b", DisplayName: "Loja B", Status: "suspended"},
	}}

	tenants, err := newRemoteBackend("prod", api).ListTenants()
	if err != nil {
		t.Fatalf("ListTenants: %v", err)
	}
	if len(tenants) != 2 {
		t.Fatalf("len = %d, want 2", len(tenants))
	}
	if tenants[0].Name != "Loja A" || tenants[0].Slug != "a" || tenants[0].Subdomain != domain {
		t.Fatalf("unexpected tenant[0]: %+v", tenants[0])
	}
	if tenants[0].Status != "active" || tenants[0].CreatedAt != "2026-01-01" {
		t.Fatalf("unexpected tenant[0] meta: %+v", tenants[0])
	}
	if tenants[1].Subdomain != "" {
		t.Fatalf("tenant[1].Subdomain = %q, want empty", tenants[1].Subdomain)
	}
}

func TestRemoteBackendGetSettingsMapping(t *testing.T) {
	api := &fakeRemoteAPI{settings: map[string]any{
		"merchant_name":                "Umami",
		"printer_enabled":              true,
		"printer_auto_print":           false,
		"uses_delivery":                true,
		"whatsapp_integration_enabled": true,
	}}

	cfg, err := newRemoteBackend("prod", api).GetSettings("umami")
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	want := &StoreConfig{
		MerchantName:    "Umami",
		PrintEnabled:    true,
		AutoPrint:       false,
		DeliveryEnabled: true,
		WhatsAppEnabled: true,
	}
	if *cfg != *want {
		t.Fatalf("cfg = %+v, want %+v", *cfg, *want)
	}
}

func TestRemoteBackendGetSettingsDefaultsMissingKeys(t *testing.T) {
	cfg, err := newRemoteBackend("prod", &fakeRemoteAPI{}).GetSettings("x")
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if cfg == nil || *cfg != (StoreConfig{}) {
		t.Fatalf("cfg = %+v, want zero StoreConfig", cfg)
	}
}

func TestStoreConfigPatchBuilding(t *testing.T) {
	cfg := &StoreConfig{
		MerchantName:    "Umami",
		PrintEnabled:    true,
		AutoPrint:       true,
		DeliveryEnabled: false,
		WhatsAppEnabled: true,
	}
	patch := storeConfigPatch(cfg)

	want := map[string]any{
		"merchant_name":                "Umami",
		"printer_enabled":              true,
		"printer_auto_print":           true,
		"uses_delivery":                false,
		"whatsapp_integration_enabled": true,
	}
	if len(patch) != len(want) {
		t.Fatalf("patch has %d keys, want %d", len(patch), len(want))
	}
	for k, v := range want {
		if patch[k] != v {
			t.Errorf("patch[%q] = %v, want %v", k, patch[k], v)
		}
	}
}

func TestRemoteBackendUpdateSettingsForwardsPatch(t *testing.T) {
	api := &fakeRemoteAPI{}
	patch := storeConfigPatch(&StoreConfig{MerchantName: "X", PrintEnabled: true})

	if err := newRemoteBackend("prod", api).UpdateSettings("umami", patch); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if api.lastPatch["merchant_name"] != "X" || api.lastPatch["printer_enabled"] != true {
		t.Fatalf("unexpected patch forwarded: %+v", api.lastPatch)
	}
}

func TestRemoteBackendCreateTenantPINPassthrough(t *testing.T) {
	pin, err := newRemoteBackend("prod", &fakeRemoteAPI{createPIN: "2468"}).CreateTenant("umami", "Umami")
	if err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}
	if pin != "2468" {
		t.Fatalf("pin = %q, want 2468", pin)
	}
}

func TestRemoteBackendBackupForwardsTarget(t *testing.T) {
	api := &fakeRemoteAPI{backupPaths: []string{"/backups/x.dump"}}
	paths, err := newRemoteBackend("prod", api).Backup("files")
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if api.lastBackup != "files" || len(paths) != 1 || paths[0] != "/backups/x.dump" {
		t.Fatalf("unexpected backup: target=%q paths=%v", api.lastBackup, paths)
	}
}

func TestLocalBackendRenameUnsupported(t *testing.T) {
	err := newLocalBackend().RenameTenant("umami", "Novo Nome")
	if err == nil {
		t.Fatal("RenameTenant local: esperado erro de não suportado")
	}
	if !strings.Contains(err.Error(), "não é suportado") {
		t.Fatalf("erro = %q, esperado conter 'não é suportado'", err)
	}
}

func TestLocalBackendClearCacheUnsupported(t *testing.T) {
	if err := newLocalBackend().ClearCache(); err == nil {
		t.Fatal("ClearCache local: esperado erro de não suportado")
	}
}

func TestLocalBackendBackupRequiresTenant(t *testing.T) {
	if _, err := newLocalBackend().Backup("db"); err == nil {
		t.Fatal("Backup local sem tenant: esperado erro")
	}
}

func TestLocalBackendMetadata(t *testing.T) {
	b := newLocalBackend()
	if b.Label() != "local" {
		t.Fatalf("Label = %q, want local", b.Label())
	}
	if b.IsRemote() {
		t.Fatal("IsRemote = true, want false")
	}
}
