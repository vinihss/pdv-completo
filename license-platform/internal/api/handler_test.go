package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/example/license-platform/internal/api"
	"github.com/example/license-platform/internal/license"
)

// --- fakes das portas de domínio: os testes HTTP também não precisam
// de banco real nem de chave Ed25519 real, apenas de implementações
// mínimas das portas license.Repository e license.Signer. ---

type memRepo struct {
	licenses map[string]license.License
}

func newMemRepo() *memRepo { return &memRepo{licenses: map[string]license.License{}} }

func (r *memRepo) Save(ctx context.Context, lic license.License) error {
	r.licenses[lic.LicenseID] = lic
	return nil
}

func (r *memRepo) FindByID(ctx context.Context, licenseID, productID, installationID string) (license.License, error) {
	lic, ok := r.licenses[licenseID]
	if !ok {
		return license.License{}, license.ErrNotFound
	}
	return lic, nil
}

var _ license.Repository = (*memRepo)(nil)

type stubClock struct{ t time.Time }

func (c stubClock) Now() time.Time { return c.t }

type stubSigner struct{}

func (stubSigner) Sign(payload []byte) ([]byte, string, error) {
	return []byte("stub-signature"), "test-key", nil
}

type discardingWriter struct{}

func (discardingWriter) Write(p []byte) (int, error) { return len(p), nil }

func silentLogger() *log.Logger { return log.New(discardingWriter{}, "", 0) }

func newTestHandler(now time.Time, repo *memRepo) *api.Handler {
	issueSvc := license.NewIssueService(repo, stubSigner{}, stubClock{t: now})
	validateSvc := license.NewValidateService(repo, stubSigner{}, stubClock{t: now})
	return api.NewHandler(issueSvc, validateSvc, silentLogger())
}

func TestHandleHealth(t *testing.T) {
	h := newTestHandler(time.Now(), newMemRepo())
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("esperava 200, obteve %d", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["status"] != "ok" {
		t.Fatalf("esperava status 'ok', obteve %q", body["status"])
	}
}

func TestHandleIssue_Success(t *testing.T) {
	h := newTestHandler(time.Now(), newMemRepo())

	payload := `{
		"license_id": "lic-1",
		"customer_id": "customer-1",
		"product_id": "erp",
		"installation_id": "inst-1",
		"status": "active",
		"features": ["reports_advanced"],
		"limits": {"max_users": 10},
		"expires_at": "2027-01-01T00:00:00Z"
	}`
	req := httptest.NewRequest(http.MethodPost, "/v1/licenses/issue", bytes.NewBufferString(payload))
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("esperava 200, obteve %d, corpo: %s", rec.Code, rec.Body.String())
	}
	var resp api.SignedLicenseResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("resposta deveria ser um SignedLicenseResponse válido: %v", err)
	}
	if resp.KeyID != "test-key" {
		t.Fatalf("esperava key_id 'test-key', obteve %q", resp.KeyID)
	}
	if len(resp.Signature) == 0 {
		t.Fatal("assinatura não deveria ser vazia")
	}
}

func TestHandleIssue_InvalidPayload_Returns400(t *testing.T) {
	h := newTestHandler(time.Now(), newMemRepo())

	req := httptest.NewRequest(http.MethodPost, "/v1/licenses/issue", bytes.NewBufferString(`{}`))
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, obteve %d", rec.Code)
	}
	var errResp api.ErrorResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &errResp)
	if errResp.Code != "invalid_payload" {
		t.Fatalf("esperava code 'invalid_payload', obteve %q", errResp.Code)
	}
}

func TestHandleIssue_MalformedJSON_Returns400(t *testing.T) {
	h := newTestHandler(time.Now(), newMemRepo())

	req := httptest.NewRequest(http.MethodPost, "/v1/licenses/issue", bytes.NewBufferString(`{not-json`))
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, obteve %d", rec.Code)
	}
}

func TestHandleValidate_NotFound_Returns404(t *testing.T) {
	h := newTestHandler(time.Now(), newMemRepo())

	payload := `{"license_id":"unknown","product_id":"erp","installation_id":"inst-1"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/licenses/validate", bytes.NewBufferString(payload))
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("esperava 404, obteve %d, corpo: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleValidate_Success_RoundTripsIssueThenValidate(t *testing.T) {
	now := time.Now()
	repo := newMemRepo()
	h := newTestHandler(now, repo)

	issuePayload := `{
		"license_id": "lic-1",
		"customer_id": "customer-1",
		"product_id": "erp",
		"installation_id": "inst-1",
		"status": "active",
		"expires_at": "2027-01-01T00:00:00Z"
	}`
	issueReq := httptest.NewRequest(http.MethodPost, "/v1/licenses/issue", bytes.NewBufferString(issuePayload))
	issueRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(issueRec, issueReq)
	if issueRec.Code != http.StatusOK {
		t.Fatalf("emissão prévia deveria retornar 200, obteve %d: %s", issueRec.Code, issueRec.Body.String())
	}

	validatePayload := `{"license_id":"lic-1","product_id":"erp","installation_id":"inst-1"}`
	validateReq := httptest.NewRequest(http.MethodPost, "/v1/licenses/validate", bytes.NewBufferString(validatePayload))
	validateRec := httptest.NewRecorder()
	h.Routes().ServeHTTP(validateRec, validateReq)

	if validateRec.Code != http.StatusOK {
		t.Fatalf("esperava 200, obteve %d: %s", validateRec.Code, validateRec.Body.String())
	}
}

func TestHandleValidate_ExpiredLicense_Returns403(t *testing.T) {
	now := time.Now()
	repo := newMemRepo()
	repo.licenses["lic-expired"] = license.License{
		LicenseID:      "lic-expired",
		CustomerID:     "customer-1",
		ProductID:      "erp",
		InstallationID: "inst-1",
		Status:         license.StatusActive,
		IssuedAt:       now.Add(-48 * time.Hour),
		ExpiresAt:      now.Add(-24 * time.Hour), // já expirou
	}
	h := newTestHandler(now, repo)

	payload := `{"license_id":"lic-expired","product_id":"erp","installation_id":"inst-1"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/licenses/validate", bytes.NewBufferString(payload))
	rec := httptest.NewRecorder()

	h.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("esperava 403, obteve %d: %s", rec.Code, rec.Body.String())
	}
	var errResp api.ErrorResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &errResp)
	if errResp.Code != "expired" {
		t.Fatalf("esperava code 'expired', obteve %q", errResp.Code)
	}
}
