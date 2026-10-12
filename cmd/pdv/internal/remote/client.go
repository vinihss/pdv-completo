// Package remote fornece um cliente HTTP para o admin-server (Fase 1 de
// docs/25-admin-server-tui.md) e os tipos dos contratos que ele devolve.
package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	healthTimeout  = 5 * time.Second
	defaultTimeout = 30 * time.Second
	createTimeout  = 6 * time.Minute
	backupTimeout  = 16 * time.Minute
)

// Health é a resposta de GET /health.
type Health struct {
	Status        string `json:"status"`
	Version       string `json:"version"`
	UptimeSeconds int    `json:"uptimeSeconds"`
}

// Tenant é um tenant do registry `public.tenant`.
type Tenant struct {
	Slug         string  `json:"slug"`
	SchemaName   string  `json:"schema_name"`
	DisplayName  string  `json:"display_name"`
	Status       string  `json:"status"`
	CustomDomain *string `json:"custom_domain"`
	CreatedAt    string  `json:"created_at"`
}

// APIError representa um erro devolvido pelo admin-server.
type APIError struct {
	StatusCode int
	Code       string
	Message    string
}

// Error implementa error.
func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("admin-server: %s (HTTP %d): %s", e.Code, e.StatusCode, e.Message)
	}
	return fmt.Sprintf("admin-server: HTTP %d: %s", e.StatusCode, e.Message)
}

// Client é o cliente HTTP do admin-server.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// New cria um cliente para o admin-server normalizando a base URL: remove
// barras finais e prefixa http:// quando não houver esquema.
func New(baseURL, token string) *Client {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "http://" + base
	}
	return &Client{
		baseURL:    base,
		token:      token,
		httpClient: &http.Client{},
	}
}

// BaseURL devolve a base URL já normalizada.
func (c *Client) BaseURL() string {
	return c.baseURL
}

// Health valida que o admin-server está no ar.
func (c *Client) Health(ctx context.Context) (*Health, error) {
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()

	var h Health
	if err := c.do(ctx, http.MethodGet, "/health", nil, &h); err != nil {
		return nil, err
	}
	return &h, nil
}

// ListTenants lista os tenants do registry.
func (c *Client) ListTenants(ctx context.Context) ([]Tenant, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	var resp struct {
		Tenants []Tenant `json:"tenants"`
	}
	if err := c.do(ctx, http.MethodGet, "/admin/tenants", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Tenants, nil
}

// CreateTenant provisiona um tenant e devolve o PIN do manager, que só é
// exposto uma única vez pelo servidor.
func (c *Client) CreateTenant(ctx context.Context, slug, displayName string) (Tenant, string, error) {
	ctx, cancel := context.WithTimeout(ctx, createTimeout)
	defer cancel()

	body := map[string]any{"slug": slug, "display_name": displayName}
	var resp struct {
		Tenant     Tenant `json:"tenant"`
		ManagerPIN string `json:"manager_pin"`
	}
	if err := c.do(ctx, http.MethodPost, "/admin/tenants", body, &resp); err != nil {
		return Tenant{}, "", err
	}
	return resp.Tenant, resp.ManagerPIN, nil
}

// RenameTenant altera o display_name de um tenant.
func (c *Client) RenameTenant(ctx context.Context, slug, displayName string) (Tenant, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	body := map[string]any{"display_name": displayName}
	var resp struct {
		Tenant Tenant `json:"tenant"`
	}
	path := "/admin/tenants/" + url.PathEscape(slug)
	if err := c.do(ctx, http.MethodPatch, path, body, &resp); err != nil {
		return Tenant{}, err
	}
	return resp.Tenant, nil
}

// SetTenantStatus alterna um tenant entre active e suspended.
func (c *Client) SetTenantStatus(ctx context.Context, slug, status string) (Tenant, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	body := map[string]any{"status": status}
	var resp struct {
		Tenant Tenant `json:"tenant"`
	}
	path := "/admin/tenants/" + url.PathEscape(slug) + "/status"
	if err := c.do(ctx, http.MethodPatch, path, body, &resp); err != nil {
		return Tenant{}, err
	}
	return resp.Tenant, nil
}

// GetSettings lê as configurações da loja de um tenant.
func (c *Client) GetSettings(ctx context.Context, slug string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	var resp struct {
		Settings map[string]any `json:"settings"`
	}
	path := "/admin/tenants/" + url.PathEscape(slug) + "/settings"
	if err := c.do(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Settings, nil
}

// UpdateSettings aplica um patch parcial nas configurações da loja.
func (c *Client) UpdateSettings(ctx context.Context, slug string, patch map[string]any) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	var resp struct {
		Settings map[string]any `json:"settings"`
	}
	path := "/admin/tenants/" + url.PathEscape(slug) + "/settings"
	if err := c.do(ctx, http.MethodPut, path, patch, &resp); err != nil {
		return nil, err
	}
	return resp.Settings, nil
}

// ClearCache limpa o cache do Redis do host.
func (c *Client) ClearCache(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	return c.do(ctx, http.MethodPost, "/admin/cache/clear", nil, nil)
}

// Backup dispara um backup no servidor e devolve os caminhos gerados.
func (c *Client) Backup(ctx context.Context, target string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, backupTimeout)
	defer cancel()

	body := map[string]any{"target": target}
	var resp struct {
		Target string   `json:"target"`
		Paths  []string `json:"paths"`
	}
	if err := c.do(ctx, http.MethodPost, "/admin/backup", body, &resp); err != nil {
		return nil, err
	}
	return resp.Paths, nil
}

// do monta e executa a requisição. O token nunca é logado.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return decodeAPIError(resp.StatusCode, data)
	}

	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return err
		}
	}
	return nil
}

// decodeAPIError traduz um corpo de erro do admin-server em *APIError. Se o
// corpo não tiver o envelope esperado, ainda devolve *APIError com fallback.
func decodeAPIError(status int, data []byte) *APIError {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &env); err == nil && (env.Error.Code != "" || env.Error.Message != "") {
		return &APIError{StatusCode: status, Code: env.Error.Code, Message: env.Error.Message}
	}

	msg := strings.TrimSpace(string(data))
	if msg == "" {
		msg = http.StatusText(status)
	}
	return &APIError{StatusCode: status, Message: msg}
}
