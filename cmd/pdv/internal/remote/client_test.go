package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthParsesBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Errorf("path = %q, want /health", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status":        "ok",
			"version":       "v1.2.3",
			"uptimeSeconds": 42,
		})
	}))
	defer srv.Close()

	h, err := New(srv.URL, "secret").Health(context.Background())
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if h.Status != "ok" || h.Version != "v1.2.3" || h.UptimeSeconds != 42 {
		t.Fatalf("unexpected health: %+v", h)
	}
}

func TestAuthorizationHeaderSent(t *testing.T) {
	var gotAuth, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	}))
	defer srv.Close()

	if _, err := New(srv.URL, "super-secret").Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
	if gotAuth != "Bearer super-secret" {
		t.Fatalf("Authorization = %q, want %q", gotAuth, "Bearer super-secret")
	}
	if gotAccept != "application/json" {
		t.Fatalf("Accept = %q, want application/json", gotAccept)
	}
}

func TestUnauthorizedReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":{"code":"unauthorized","message":"token inválido"}}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "bad").ListTenants(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if apiErr.StatusCode != 401 {
		t.Fatalf("StatusCode = %d, want 401", apiErr.StatusCode)
	}
	if apiErr.Code != "unauthorized" {
		t.Fatalf("Code = %q, want unauthorized", apiErr.Code)
	}
}

func TestAPIErrorFallbackBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("gateway explodiu"))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "t").ListTenants(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if apiErr.StatusCode != 502 || apiErr.Code != "" || apiErr.Message != "gateway explodiu" {
		t.Fatalf("unexpected APIError: %+v", apiErr)
	}
}

func TestCreateTenantReturnsPin(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/tenants" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		var body struct {
			Slug        string `json:"slug"`
			DisplayName string `json:"display_name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if body.Slug != "umami" || body.DisplayName != "Umami Sushi" {
			t.Errorf("unexpected body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"tenant":      map[string]any{"slug": "umami", "display_name": "Umami Sushi", "status": "active"},
			"manager_pin": "2468",
		})
	}))
	defer srv.Close()

	tenant, pin, err := New(srv.URL, "t").CreateTenant(context.Background(), "umami", "Umami Sushi")
	if err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}
	if tenant.Slug != "umami" || tenant.DisplayName != "Umami Sushi" || tenant.Status != "active" {
		t.Fatalf("unexpected tenant: %+v", tenant)
	}
	if pin != "2468" {
		t.Fatalf("pin = %q, want 2468", pin)
	}
}

func TestBackupReturnsPaths(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/admin/backup" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"target": "all",
			"paths":  []string{"/backups/pdv.dump", "/backups/uploads.tar.gz"},
		})
	}))
	defer srv.Close()

	paths, err := New(srv.URL, "t").Backup(context.Background(), "all")
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if len(paths) != 2 || paths[0] != "/backups/pdv.dump" || paths[1] != "/backups/uploads.tar.gz" {
		t.Fatalf("unexpected paths: %v", paths)
	}
}

func TestNewNormalizesURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"example.com:9090/", "http://example.com:9090"},
		{"http://example.com:9090/", "http://example.com:9090"},
		{"https://admin.example.com/base/", "https://admin.example.com/base"},
		{"  127.0.0.1:9090  ", "http://127.0.0.1:9090"},
	}
	for _, tc := range cases {
		if got := New(tc.in, "t").BaseURL(); got != tc.want {
			t.Errorf("New(%q).BaseURL() = %q, want %q", tc.in, got, tc.want)
		}
	}
}
