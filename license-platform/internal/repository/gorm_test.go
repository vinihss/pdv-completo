package repository_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"github.com/example/license-platform/internal/license"
	"github.com/example/license-platform/internal/repository"
)

// newTestDB abre um banco SQLite em memória isolado por teste. Usar
// ":memory:" evita arquivos residuais no disco e permite paralelismo
// seguro entre testes.
func newTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("abrindo banco de teste: %v", err)
	}
	return db
}

func sampleLicense() license.License {
	now := time.Now().UTC().Truncate(time.Second)
	return license.License{
		Version:        1,
		Issuer:         "license-server.local",
		LicenseID:      "lic-1",
		CustomerID:     "customer-1",
		ProductID:      "erp",
		InstallationID: "inst-1",
		Status:         license.StatusActive,
		Features:       map[string]bool{"reports_advanced": true, "financial": true},
		Limits:         map[string]int64{"max_users": 10},
		IssuedAt:       now,
		ExpiresAt:      now.Add(365 * 24 * time.Hour),
	}
}

func TestGorm_SaveAndFindByID_RoundTrip(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewGorm(db)
	if err := repo.AutoMigrate(); err != nil {
		t.Fatalf("automigrate não deveria falhar: %v", err)
	}

	original := sampleLicense()
	if err := repo.Save(context.Background(), original); err != nil {
		t.Fatalf("save não deveria falhar: %v", err)
	}

	got, err := repo.FindByID(context.Background(), "lic-1", "erp", "inst-1")
	if err != nil {
		t.Fatalf("findByID não deveria falhar: %v", err)
	}

	if got.LicenseID != original.LicenseID ||
		got.CustomerID != original.CustomerID ||
		got.Status != original.Status {
		t.Fatalf("registro recuperado difere do original: %+v vs %+v", got, original)
	}
	if !got.HasFeature("reports_advanced") {
		t.Fatal("feature 'reports_advanced' deveria ter sido persistida e recuperada")
	}
	limit, ok := got.Limit("max_users")
	if !ok || limit != 10 {
		t.Fatalf("limite max_users deveria ser 10, obteve %d (ok=%v)", limit, ok)
	}
	if !got.ExpiresAt.Equal(original.ExpiresAt) {
		t.Fatalf("expires_at deveria ser preservado: esperava %v, obteve %v", original.ExpiresAt, got.ExpiresAt)
	}
}

func TestGorm_Save_UpsertsExistingLicense(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewGorm(db)
	_ = repo.AutoMigrate()

	lic := sampleLicense()
	_ = repo.Save(context.Background(), lic)

	lic.Status = license.StatusSuspended
	if err := repo.Save(context.Background(), lic); err != nil {
		t.Fatalf("segundo save (upsert) não deveria falhar: %v", err)
	}

	got, err := repo.FindByID(context.Background(), "lic-1", "erp", "inst-1")
	if err != nil {
		t.Fatalf("findByID não deveria falhar: %v", err)
	}
	if got.Status != license.StatusSuspended {
		t.Fatalf("esperava status atualizado para suspended, obteve %q", got.Status)
	}
}

func TestGorm_FindByID_NotFound(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewGorm(db)
	_ = repo.AutoMigrate()

	_, err := repo.FindByID(context.Background(), "inexistente", "erp", "inst-1")
	if err == nil {
		t.Fatal("esperava erro ao buscar licença inexistente")
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("esperava erro encapsulando gorm.ErrRecordNotFound, obteve %v", err)
	}
}

// TestGorm_SatisfiesRepositoryPort é um teste de documentação: garante
// em tempo de compilação (via var _ em gorm.go) e em tempo de execução
// que Gorm pode ser usado onde a porta license.Repository é esperada.
func TestGorm_SatisfiesRepositoryPort(t *testing.T) {
	db := newTestDB(t)
	var repo license.Repository = repository.NewGorm(db)
	if repo == nil {
		t.Fatal("Gorm deveria satisfazer license.Repository")
	}
}
