package license_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/example/license-platform/internal/license"
)

// --- fakes das portas, usados só nos testes de domínio ---

type fakeRepo struct {
	licenses map[string]license.License
	saveErr  error
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{licenses: map[string]license.License{}}
}

func (f *fakeRepo) Save(ctx context.Context, lic license.License) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.licenses[lic.LicenseID] = lic
	return nil
}

func (f *fakeRepo) FindByID(ctx context.Context, licenseID, productID, installationID string) (license.License, error) {
	lic, ok := f.licenses[licenseID]
	if !ok {
		return license.License{}, errors.New("not found in fake repo")
	}
	return lic, nil
}

type fakeSigner struct{ signErr error }

func (f fakeSigner) Sign(payload []byte) ([]byte, string, error) {
	if f.signErr != nil {
		return nil, "", f.signErr
	}
	return []byte("fake-signature"), "test-key", nil
}

type fixedClock struct{ t time.Time }

func (c fixedClock) Now() time.Time { return c.t }

func validLicense(now time.Time) license.License {
	return license.License{
		Version:        1,
		Issuer:         "license-server.local",
		LicenseID:      "lic-1",
		CustomerID:     "customer-1",
		ProductID:      "erp",
		InstallationID: "inst-1",
		Status:         license.StatusActive,
		Features:       map[string]bool{"reports_advanced": true},
		Limits:         map[string]int64{"max_users": 10},
		IssuedAt:       now,
		ExpiresAt:      now.Add(365 * 24 * time.Hour),
	}
}

// --- License.Validate ---

func TestLicense_Validate_RejectsMissingFields(t *testing.T) {
	now := time.Now()
	lic := validLicense(now)
	lic.LicenseID = ""

	if err := lic.Validate(); !errors.Is(err, license.ErrMissingLicenseID) {
		t.Fatalf("esperava ErrMissingLicenseID, obteve %v", err)
	}
}

func TestLicense_Validate_RejectsExpiresBeforeIssued(t *testing.T) {
	now := time.Now()
	lic := validLicense(now)
	lic.ExpiresAt = now.Add(-time.Hour)

	if err := lic.Validate(); !errors.Is(err, license.ErrExpiresBeforeIssued) {
		t.Fatalf("esperava ErrExpiresBeforeIssued, obteve %v", err)
	}
}

func TestLicense_Validate_RejectsLeaseAfterExpiry(t *testing.T) {
	now := time.Now()
	lic := validLicense(now)
	lic.LeaseUntil = lic.ExpiresAt.Add(time.Hour)

	if err := lic.Validate(); !errors.Is(err, license.ErrLeaseAfterExpiry) {
		t.Fatalf("esperava ErrLeaseAfterExpiry, obteve %v", err)
	}
}

func TestLicense_Validate_AcceptsValidLicense(t *testing.T) {
	lic := validLicense(time.Now())
	if err := lic.Validate(); err != nil {
		t.Fatalf("licença válida não deveria falhar: %v", err)
	}
}

func TestLicense_IsExpired(t *testing.T) {
	now := time.Now()
	lic := validLicense(now)

	if lic.IsExpired(now) {
		t.Fatal("licença não deveria estar expirada no momento da emissão")
	}
	if !lic.IsExpired(lic.ExpiresAt.Add(time.Second)) {
		t.Fatal("licença deveria estar expirada após expires_at")
	}
}

// --- IssueService ---

func TestIssueService_RejectsInvalidPayload(t *testing.T) {
	svc := license.NewIssueService(newFakeRepo(), fakeSigner{}, fixedClock{t: time.Now()})

	_, err := svc.Issue(context.Background(), license.License{})
	if !errors.Is(err, license.ErrInvalidPayload) {
		t.Fatalf("esperava ErrInvalidPayload, obteve %v", err)
	}
}

func TestIssueService_PersistsAndSignsValidLicense(t *testing.T) {
	now := time.Now()
	repo := newFakeRepo()
	svc := license.NewIssueService(repo, fakeSigner{}, fixedClock{t: now})

	signed, err := svc.Issue(context.Background(), validLicense(now))
	if err != nil {
		t.Fatalf("emissão não deveria falhar: %v", err)
	}
	if signed.KeyID != "test-key" {
		t.Fatalf("esperava key_id 'test-key', obteve %q", signed.KeyID)
	}
	if len(signed.Signature) == 0 {
		t.Fatal("assinatura não deveria ser vazia")
	}
	if _, ok := repo.licenses["lic-1"]; !ok {
		t.Fatal("licença deveria ter sido persistida no repositório")
	}
}

func TestIssueService_WrapsSigningFailure(t *testing.T) {
	repo := newFakeRepo()
	svc := license.NewIssueService(repo, fakeSigner{signErr: errors.New("hsm indisponível")}, fixedClock{t: time.Now()})

	_, err := svc.Issue(context.Background(), validLicense(time.Now()))
	if !errors.Is(err, license.ErrSigningFailed) {
		t.Fatalf("esperava ErrSigningFailed, obteve %v", err)
	}
}

func TestIssueService_FillsIssuedAtFromClock(t *testing.T) {
	fixedNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	repo := newFakeRepo()
	svc := license.NewIssueService(repo, fakeSigner{}, fixedClock{t: fixedNow})

	lic := validLicense(fixedNow)
	lic.IssuedAt = time.Time{} // não informado pelo chamador
	lic.ExpiresAt = fixedNow.Add(time.Hour)

	if _, err := svc.Issue(context.Background(), lic); err != nil {
		t.Fatalf("emissão não deveria falhar: %v", err)
	}
	if got := repo.licenses["lic-1"].IssuedAt; !got.Equal(fixedNow) {
		t.Fatalf("esperava issued_at preenchido pelo clock (%v), obteve %v", fixedNow, got)
	}
}

// --- ValidateService ---

func TestValidateService_NotFound(t *testing.T) {
	svc := license.NewValidateService(newFakeRepo(), fakeSigner{}, fixedClock{t: time.Now()})

	_, err := svc.Validate(context.Background(), license.ValidateRequest{
		LicenseID: "unknown", ProductID: "erp", InstallationID: "inst-1",
	})
	if !errors.Is(err, license.ErrNotFound) {
		t.Fatalf("esperava ErrNotFound, obteve %v", err)
	}
}

func TestValidateService_InstallationMismatch(t *testing.T) {
	now := time.Now()
	repo := newFakeRepo()
	repo.licenses["lic-1"] = validLicense(now)

	svc := license.NewValidateService(repo, fakeSigner{}, fixedClock{t: now})
	_, err := svc.Validate(context.Background(), license.ValidateRequest{
		LicenseID: "lic-1", ProductID: "erp", InstallationID: "outra-instalacao",
	})
	if !errors.Is(err, license.ErrInstallationMismatch) {
		t.Fatalf("esperava ErrInstallationMismatch, obteve %v", err)
	}
}

func TestValidateService_NotActive(t *testing.T) {
	now := time.Now()
	repo := newFakeRepo()
	lic := validLicense(now)
	lic.Status = license.StatusSuspended
	repo.licenses["lic-1"] = lic

	svc := license.NewValidateService(repo, fakeSigner{}, fixedClock{t: now})
	_, err := svc.Validate(context.Background(), license.ValidateRequest{
		LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1",
	})
	if !errors.Is(err, license.ErrNotActive) {
		t.Fatalf("esperava ErrNotActive, obteve %v", err)
	}
}

func TestValidateService_Expired(t *testing.T) {
	issuedAt := time.Now().Add(-48 * time.Hour)
	repo := newFakeRepo()
	lic := validLicense(issuedAt)
	lic.ExpiresAt = issuedAt.Add(time.Hour) // já expirou
	repo.licenses["lic-1"] = lic

	svc := license.NewValidateService(repo, fakeSigner{}, fixedClock{t: time.Now()})
	_, err := svc.Validate(context.Background(), license.ValidateRequest{
		LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1",
	})
	if !errors.Is(err, license.ErrExpired) {
		t.Fatalf("esperava ErrExpired, obteve %v", err)
	}
}

func TestValidateService_SuccessReturnsFreshSignature(t *testing.T) {
	now := time.Now()
	repo := newFakeRepo()
	repo.licenses["lic-1"] = validLicense(now)

	svc := license.NewValidateService(repo, fakeSigner{}, fixedClock{t: now})
	signed, err := svc.Validate(context.Background(), license.ValidateRequest{
		LicenseID: "lic-1", ProductID: "erp", InstallationID: "inst-1",
	})
	if err != nil {
		t.Fatalf("validação não deveria falhar: %v", err)
	}
	if len(signed.Signature) == 0 {
		t.Fatal("assinatura não deveria ser vazia")
	}

	decoded, err := license.CanonicalDecode(signed.Payload)
	if err != nil {
		t.Fatalf("payload deveria ser decodificável: %v", err)
	}
	if decoded.LicenseID != "lic-1" {
		t.Fatalf("payload decodificado não corresponde à licença original: %+v", decoded)
	}
}
