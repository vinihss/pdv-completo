package licensego_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/example/license-platform/sdk/licensego"
	"github.com/example/license-platform/sdk/licensego/cache"
	"github.com/example/license-platform/sdk/licensego/model"
)

// wireDoc espelha o formato canônico assinado pelo servidor, só para
// montar payloads de teste sem depender do módulo do servidor.
type wireDoc struct {
	Version        int              `json:"version"`
	Issuer         string           `json:"issuer"`
	LicenseID      string           `json:"license_id"`
	CustomerID     string           `json:"customer_id"`
	ProductID      string           `json:"product_id"`
	InstallationID string           `json:"installation_id"`
	Status         string           `json:"status"`
	Features       map[string]bool  `json:"features,omitempty"`
	Limits         map[string]int64 `json:"limits,omitempty"`
	IssuedAt       string           `json:"issued_at"`
	ExpiresAt      string           `json:"expires_at"`
	LeaseUntil     string           `json:"lease_until,omitempty"`
	OfflineUntil   string           `json:"offline_until,omitempty"`
}

type signedResp struct {
	KeyID     string `json:"key_id"`
	Payload   []byte `json:"payload"`
	Signature []byte `json:"signature"`
}

// testServer cria um par de chaves Ed25519 e um httptest.Server que
// sempre responde ao endpoint de validação com um documento assinado
// por essa chave — o suficiente para exercitar Client.Check/Refresh
// de ponta a ponta sem depender do binário real do servidor.
func testServer(t *testing.T, doc wireDoc) (*httptest.Server, map[string]ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("gerando chave de teste: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, err := json.Marshal(doc)
		if err != nil {
			t.Fatalf("codificando payload de teste: %v", err)
		}
		sig := ed25519.Sign(priv, payload)
		resp := signedResp{KeyID: "test-key", Payload: payload, Signature: sig}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	return srv, map[string]ed25519.PublicKey{"test-key": pub}
}

func newClient(t *testing.T, baseURL string, trustedKeys map[string]ed25519.PublicKey, now time.Time) *licensego.Client {
	t.Helper()
	return &licensego.Client{
		BaseURL:        baseURL,
		LicenseID:      "lic-1",
		ProductID:      "erp",
		InstallationID: "inst-1",
		PublicKeys:     trustedKeys,
		Cache:          cache.FileStore{Path: filepath.Join(t.TempDir(), "cache.json")},
		Now:            func() time.Time { return now },
	}
}

func TestClient_Check_ServerReachable_ReturnsActive(t *testing.T) {
	now := time.Now().UTC()
	doc := wireDoc{
		Version: 1, Issuer: "license-server.local",
		LicenseID: "lic-1", CustomerID: "customer-1", ProductID: "erp", InstallationID: "inst-1",
		Status:    "active",
		Features:  map[string]bool{"reports_advanced": true},
		Limits:    map[string]int64{"max_users": 10},
		IssuedAt:  now.Format(time.RFC3339),
		ExpiresAt: now.Add(365 * 24 * time.Hour).Format(time.RFC3339),
	}
	srv, keys := testServer(t, doc)
	defer srv.Close()

	client := newClient(t, srv.URL, keys, now)
	result, err := client.Check(context.Background())
	if err != nil {
		t.Fatalf("check não deveria retornar erro: %v", err)
	}
	if result.State != model.StateActive {
		t.Fatalf("esperava StateActive, obteve %v", result.State)
	}
	if !result.Valid {
		t.Fatal("resultado deveria ser válido")
	}
	if !result.Document.HasFeature("reports_advanced") {
		t.Fatal("feature 'reports_advanced' deveria estar presente no documento")
	}
	limit, ok := result.Document.Limit("max_users")
	if !ok || limit != 10 {
		t.Fatalf("esperava limite max_users=10, obteve %d (ok=%v)", limit, ok)
	}
}

func TestClient_Check_SavesToCache(t *testing.T) {
	now := time.Now().UTC()
	doc := wireDoc{
		LicenseID: "lic-1", CustomerID: "customer-1", ProductID: "erp", InstallationID: "inst-1",
		Status: "active", IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
	}
	srv, keys := testServer(t, doc)
	defer srv.Close()

	cachePath := filepath.Join(t.TempDir(), "cache.json")
	client := &licensego.Client{
		BaseURL: srv.URL, LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1",
		PublicKeys: keys, Cache: cache.FileStore{Path: cachePath}, Now: func() time.Time { return now },
	}

	if _, err := client.Check(context.Background()); err != nil {
		t.Fatalf("check não deveria falhar: %v", err)
	}

	entry, err := (cache.FileStore{Path: cachePath}).Load()
	if err != nil {
		t.Fatalf("cache deveria ter sido gravado: %v", err)
	}
	if entry.KeyID != "test-key" {
		t.Fatalf("esperava key_id 'test-key' no cache, obteve %q", entry.KeyID)
	}
}

func TestClient_Check_ServerUnreachable_FallsBackToCache(t *testing.T) {
	now := time.Now().UTC()
	doc := wireDoc{
		LicenseID: "lic-1", CustomerID: "customer-1", ProductID: "erp", InstallationID: "inst-1",
		Status:       "active",
		IssuedAt:     now.Add(-time.Hour).Format(time.RFC3339),
		ExpiresAt:    now.Add(24 * time.Hour).Format(time.RFC3339),
		LeaseUntil:   now.Add(-time.Minute).Format(time.RFC3339), // lease já expirou
		OfflineUntil: now.Add(48 * time.Hour).Format(time.RFC3339),
	}
	srv, keys := testServer(t, doc)

	cachePath := filepath.Join(t.TempDir(), "cache.json")
	client := &licensego.Client{
		BaseURL: srv.URL, LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1",
		PublicKeys: keys, Cache: cache.FileStore{Path: cachePath}, Now: func() time.Time { return now },
	}

	// Primeira chamada: servidor no ar, popula o cache.
	if _, err := client.Check(context.Background()); err != nil {
		t.Fatalf("primeiro check não deveria falhar: %v", err)
	}

	// Servidor cai; segunda chamada deve cair para o cache e, como o
	// lease já expirou mas ainda está dentro da janela offline,
	// retornar grace_period.
	srv.Close()

	result, err := client.Check(context.Background())
	if err != nil {
		t.Fatalf("check não deveria retornar erro mesmo com servidor indisponível: %v", err)
	}
	if result.State != model.StateGracePeriod {
		t.Fatalf("esperava StateGracePeriod com servidor indisponível e lease expirado, obteve %v", result.State)
	}
	if !result.Valid {
		t.Fatal("grace_period ainda deveria ser considerado válido")
	}
}

func TestClient_Check_NoServerNoCache_ReturnsInvalid(t *testing.T) {
	client := &licensego.Client{
		BaseURL: "http://127.0.0.1:1", // porta inválida, conexão sempre falha
		LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1",
		PublicKeys: map[string]ed25519.PublicKey{},
		Cache:      cache.FileStore{Path: filepath.Join(t.TempDir(), "cache.json")},
	}

	result, err := client.Check(context.Background())
	if err != nil {
		t.Fatalf("check não deveria retornar erro, e sim StateInvalid: %v", err)
	}
	if result.State != model.StateInvalid {
		t.Fatalf("esperava StateInvalid sem servidor nem cache, obteve %v", result.State)
	}
	if result.Valid {
		t.Fatal("resultado não deveria ser válido")
	}
}

func TestClient_Check_UntrustedKeyID_ReturnsInvalid(t *testing.T) {
	now := time.Now().UTC()
	doc := wireDoc{
		LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1", Status: "active",
		IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
	}
	srv, _ := testServer(t, doc)
	defer srv.Close()

	// Chaves confiáveis vazias — o servidor de teste assina com
	// "test-key", que não está no mapa do cliente.
	client := newClient(t, srv.URL, map[string]ed25519.PublicKey{}, now)

	result, err := client.Check(context.Background())
	if err != nil {
		t.Fatalf("check não deveria retornar erro: %v", err)
	}
	if result.State != model.StateInvalid {
		t.Fatalf("esperava StateInvalid para key_id não confiável, obteve %v", result.State)
	}
}

func TestClient_Refresh_UpdatesCache(t *testing.T) {
	now := time.Now().UTC()
	doc := wireDoc{
		LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1", Status: "active",
		IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
	}
	srv, keys := testServer(t, doc)
	defer srv.Close()

	cachePath := filepath.Join(t.TempDir(), "cache.json")
	client := &licensego.Client{
		BaseURL: srv.URL, LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1",
		PublicKeys: keys, Cache: cache.FileStore{Path: cachePath}, Now: func() time.Time { return now },
	}

	if err := client.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh não deveria falhar: %v", err)
	}

	if _, err := (cache.FileStore{Path: cachePath}).Load(); err != nil {
		t.Fatalf("cache deveria ter sido populado pelo refresh: %v", err)
	}
}

func TestClient_Refresh_ServerDown_ReturnsError(t *testing.T) {
	client := &licensego.Client{
		BaseURL: "http://127.0.0.1:1",
		LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1",
		PublicKeys: map[string]ed25519.PublicKey{},
		Cache:      cache.FileStore{Path: filepath.Join(t.TempDir(), "cache.json")},
	}

	if err := client.Refresh(context.Background()); err == nil {
		t.Fatal("refresh deveria retornar erro quando o servidor está indisponível")
	}
}
