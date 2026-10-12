package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pdv-admin-server/internal/settings"
	"pdv-admin-server/internal/tenants"
)

// --- fakes ---

type fakeTenantStore struct {
	list      []tenants.Tenant
	bySlug    map[string]tenants.Tenant
	updated   tenants.Tenant
	found     bool
	returnErr error
}

func (f *fakeTenantStore) ListTenants(context.Context) ([]tenants.Tenant, error) {
	if f.returnErr != nil {
		return nil, f.returnErr
	}
	return f.list, nil
}

func (f *fakeTenantStore) GetTenant(_ context.Context, slug string) (tenants.Tenant, bool, error) {
	if f.returnErr != nil {
		return tenants.Tenant{}, false, f.returnErr
	}
	t, ok := f.bySlug[slug]
	return t, ok, nil
}

func (f *fakeTenantStore) UpdateTenantName(_ context.Context, slug, displayName string) (tenants.Tenant, bool, error) {
	if f.returnErr != nil {
		return tenants.Tenant{}, false, f.returnErr
	}
	t, ok := f.bySlug[slug]
	if !ok {
		return tenants.Tenant{}, false, nil
	}
	t.DisplayName = displayName
	return t, true, nil
}

func (f *fakeTenantStore) UpdateTenantStatus(_ context.Context, slug, status string) (tenants.Tenant, bool, error) {
	if f.returnErr != nil {
		return tenants.Tenant{}, false, f.returnErr
	}
	t, ok := f.bySlug[slug]
	if !ok {
		return tenants.Tenant{}, false, nil
	}
	t.Status = status
	return t, true, nil
}

type fakeSettingsStore struct {
	current *settings.StoreSettings
	found   bool
}

func (f *fakeSettingsStore) GetSettings(context.Context, string) (*settings.StoreSettings, bool, error) {
	return f.current, f.found, nil
}

func (f *fakeSettingsStore) UpdateSettings(context.Context, string, *settings.Patch) (*settings.StoreSettings, bool, error) {
	return f.current, f.found, nil
}

type fakeProvisioner struct {
	pin string
	err error
}

func (f *fakeProvisioner) Provision(context.Context, string, string) (string, error) {
	return f.pin, f.err
}

type fakeCache struct{ err error }

func (f *fakeCache) Flush(context.Context) error { return f.err }

type fakeBackup struct {
	paths []string
	err   error
}

func (f *fakeBackup) Backup(context.Context, string) ([]string, error) {
	return f.paths, f.err
}

// --- helpers ---

func testServer(deps Deps) *Server {
	if deps.Started.IsZero() {
		deps.Started = time.Now()
	}
	if deps.Version == "" {
		deps.Version = "test"
	}
	return New(deps)
}

func doRequest(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	w := httptest.NewRecorder()
	s.AdminHandler().ServeHTTP(w, r)
	return w
}

func decodeMap(t *testing.T, w *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("resposta não é JSON: %v — corpo: %s", err, w.Body.String())
	}
	return m
}

func sampleTenant() tenants.Tenant {
	return tenants.Tenant{
		Slug:        "umami",
		SchemaName:  "tenant_umami",
		DisplayName: "Umami Sushi",
		Status:      "active",
		CreatedAt:   "2026-10-11T12:00:00.000Z",
	}
}

func sampleSettings() *settings.StoreSettings {
	return &settings.StoreSettings{ID: "singleton", MerchantName: "Umami Sushi"}
}

// --- testes ---

func TestHealth(t *testing.T) {
	s := testServer(Deps{})
	r := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	s.HealthHandler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status %d, quer 200", w.Code)
	}
	m := decodeMap(t, w)
	if string(m["status"]) != `"ok"` {
		t.Errorf("status = %s", m["status"])
	}
	if _, ok := m["uptimeSeconds"]; !ok {
		t.Error("resposta sem uptimeSeconds")
	}
	if string(m["version"]) != `"test"` {
		t.Errorf("version = %s", m["version"])
	}
}

func TestListTenants(t *testing.T) {
	s := testServer(Deps{Tenants: &fakeTenantStore{list: []tenants.Tenant{sampleTenant()}}})
	w := doRequest(t, s, http.MethodGet, "/admin/tenants", "")

	if w.Code != http.StatusOK {
		t.Fatalf("status %d, quer 200", w.Code)
	}
	if got := w.Body.String(); !strings.Contains(got, `"custom_domain":null`) {
		t.Errorf("custom_domain ausente deveria ser null: %s", got)
	}
	m := decodeMap(t, w)
	var list []tenants.Tenant
	if err := json.Unmarshal(m["tenants"], &list); err != nil {
		t.Fatalf("tenants inválido: %v", err)
	}
	if len(list) != 1 || list[0].Slug != "umami" {
		t.Errorf("tenants = %+v", list)
	}
}

func TestListTenantsVazio(t *testing.T) {
	s := testServer(Deps{Tenants: &fakeTenantStore{}})
	w := doRequest(t, s, http.MethodGet, "/admin/tenants", "")
	if string(decodeMap(t, w)["tenants"]) != `[]` {
		t.Errorf("lista vazia = %s, quer []", decodeMap(t, w)["tenants"])
	}
}

func TestCreateTenant(t *testing.T) {
	store := &fakeTenantStore{bySlug: map[string]tenants.Tenant{"umami": sampleTenant()}}
	s := testServer(Deps{Tenants: store, Provisioner: &fakeProvisioner{pin: "1234"}})

	w := doRequest(t, s, http.MethodPost, "/admin/tenants", `{"slug":"umami","display_name":"Umami Sushi"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("status %d, quer 201: %s", w.Code, w.Body.String())
	}
	m := decodeMap(t, w)
	if string(m["manager_pin"]) != `"1234"` {
		t.Errorf("manager_pin = %s", m["manager_pin"])
	}
	var tt tenants.Tenant
	if err := json.Unmarshal(m["tenant"], &tt); err != nil || tt.Slug != "umami" {
		t.Errorf("tenant = %s", m["tenant"])
	}
}

func TestCreateTenantSlugInvalido(t *testing.T) {
	s := testServer(Deps{Tenants: &fakeTenantStore{}, Provisioner: &fakeProvisioner{}})
	w := doRequest(t, s, http.MethodPost, "/admin/tenants", `{"slug":"Umami Sushi","display_name":"x"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, quer 400", w.Code)
	}
	if code := errorCode(t, w); code != "invalid_slug" {
		t.Errorf("code = %q, quer invalid_slug", code)
	}
}

func TestCreateTenantProvisionFalhou(t *testing.T) {
	s := testServer(Deps{
		Tenants:     &fakeTenantStore{},
		Provisioner: &fakeProvisioner{err: &tenants.ProvisionError{Output: "boom no script", Err: errors.New("exit 1")}},
	})
	w := doRequest(t, s, http.MethodPost, "/admin/tenants", `{"slug":"umami","display_name":"x"}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, quer 500", w.Code)
	}
	m := decodeMap(t, w)
	if code := errorCode(t, w); code != "provision_failed" {
		t.Errorf("code = %q, quer provision_failed", code)
	}
	if !strings.Contains(string(m["error"]), "boom no script") {
		t.Errorf("mensagem sem a saída do script: %s", m["error"])
	}
}

func TestRenameTenant(t *testing.T) {
	store := &fakeTenantStore{bySlug: map[string]tenants.Tenant{"umami": sampleTenant()}}
	s := testServer(Deps{Tenants: store})

	w := doRequest(t, s, http.MethodPatch, "/admin/tenants/umami", `{"display_name":"Novo Nome"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, quer 200: %s", w.Code, w.Body.String())
	}
	var tt tenants.Tenant
	if err := json.Unmarshal(decodeMap(t, w)["tenant"], &tt); err != nil || tt.DisplayName != "Novo Nome" {
		t.Errorf("tenant = %+v (err %v)", tt, err)
	}
}

func TestRenameTenantDesconhecido(t *testing.T) {
	s := testServer(Deps{Tenants: &fakeTenantStore{bySlug: map[string]tenants.Tenant{}}})
	w := doRequest(t, s, http.MethodPatch, "/admin/tenants/naoexiste", `{"display_name":"x"}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status %d, quer 404", w.Code)
	}
}

func TestTenantStatus(t *testing.T) {
	store := &fakeTenantStore{bySlug: map[string]tenants.Tenant{"umami": sampleTenant()}}
	s := testServer(Deps{Tenants: store})

	w := doRequest(t, s, http.MethodPatch, "/admin/tenants/umami/status", `{"status":"suspended"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, quer 200: %s", w.Code, w.Body.String())
	}
	var tt tenants.Tenant
	_ = json.Unmarshal(decodeMap(t, w)["tenant"], &tt)
	if tt.Status != "suspended" {
		t.Errorf("status = %q", tt.Status)
	}
}

func TestTenantStatusInvalido(t *testing.T) {
	s := testServer(Deps{Tenants: &fakeTenantStore{bySlug: map[string]tenants.Tenant{"umami": sampleTenant()}}})
	w := doRequest(t, s, http.MethodPatch, "/admin/tenants/umami/status", `{"status":"banido"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, quer 400", w.Code)
	}
	if code := errorCode(t, w); code != "invalid_status" {
		t.Errorf("code = %q", code)
	}
}

func TestGetSettings(t *testing.T) {
	s := testServer(Deps{Settings: &fakeSettingsStore{current: sampleSettings(), found: true}})
	w := doRequest(t, s, http.MethodGet, "/admin/tenants/umami/settings", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, quer 200", w.Code)
	}
	if _, ok := decodeMap(t, w)["settings"]; !ok {
		t.Error("resposta sem settings")
	}
}

func TestGetSettingsDesconhecido(t *testing.T) {
	s := testServer(Deps{Settings: &fakeSettingsStore{found: false}})
	w := doRequest(t, s, http.MethodGet, "/admin/tenants/naoexiste/settings", "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status %d, quer 404", w.Code)
	}
}

func TestPutSettingsDesconhecido(t *testing.T) {
	s := testServer(Deps{Settings: &fakeSettingsStore{found: true, current: sampleSettings()}})
	w := doRequest(t, s, http.MethodPut, "/admin/tenants/umami/settings", `{"nao_existe":1}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, quer 400", w.Code)
	}
	if code := errorCode(t, w); code != "unknown_field" {
		t.Errorf("code = %q, quer unknown_field", code)
	}
}

func TestPutSettings(t *testing.T) {
	s := testServer(Deps{Settings: &fakeSettingsStore{found: true, current: sampleSettings()}})
	w := doRequest(t, s, http.MethodPut, "/admin/tenants/umami/settings", `{"merchant_name":"Novo"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, quer 200: %s", w.Code, w.Body.String())
	}
	if _, ok := decodeMap(t, w)["settings"]; !ok {
		t.Error("resposta sem settings")
	}
}

func TestCacheClear(t *testing.T) {
	s := testServer(Deps{Cache: &fakeCache{}})
	w := doRequest(t, s, http.MethodPost, "/admin/cache/clear", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, quer 200", w.Code)
	}
	if string(decodeMap(t, w)["flushed"]) != `true` {
		t.Errorf("flushed = %s", decodeMap(t, w)["flushed"])
	}
}

func TestBackup(t *testing.T) {
	s := testServer(Deps{Backup: &fakeBackup{paths: []string{"/opt/pdv/deploy/backups/pdv-x.dump", "/opt/pdv/deploy/backups/pdv-x-uploads.tar.gz"}}})
	w := doRequest(t, s, http.MethodPost, "/admin/backup", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, quer 200: %s", w.Code, w.Body.String())
	}
	m := decodeMap(t, w)
	if string(m["target"]) != `"all"` {
		t.Errorf("target default = %s, quer all", m["target"])
	}
	var paths []string
	_ = json.Unmarshal(m["paths"], &paths)
	if len(paths) != 2 {
		t.Errorf("paths = %v", paths)
	}
}

func TestBackupTargetInvalido(t *testing.T) {
	s := testServer(Deps{Backup: &fakeBackup{}})
	w := doRequest(t, s, http.MethodPost, "/admin/backup", `{"target":"tudo"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, quer 400", w.Code)
	}
	if code := errorCode(t, w); code != "invalid_target" {
		t.Errorf("code = %q", code)
	}
}

func TestBackupNaoConfigurado(t *testing.T) {
	s := testServer(Deps{Backup: &fakeBackup{err: tenants.ErrNotConfigured}})
	w := doRequest(t, s, http.MethodPost, "/admin/backup", `{"target":"db"}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, quer 503", w.Code)
	}
	if code := errorCode(t, w); code != "not_configured" {
		t.Errorf("code = %q", code)
	}
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("resposta de erro não é JSON: %v", err)
	}
	return env.Error.Code
}
