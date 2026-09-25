package repository

import (
	"context"
	"errors"
	"fmt"

	"gorm.io/gorm"

	"github.com/example/license-platform/internal/license"
)

// Gorm implementa a porta license.Repository (LicenseReader + LicenseWriter)
// usando GORM. É o único lugar do sistema, além de model.go, que conhece
// gorm.DB — o domínio nunca importa este pacote; é este pacote que importa
// o domínio, conforme ADR-01 (inversão de dependência).
type Gorm struct {
	db *gorm.DB
}

// NewGorm recebe uma conexão *gorm.DB já aberta. A abertura da conexão
// (qual driver, qual DSN) é responsabilidade exclusiva de cmd/license-server —
// este construtor não decide isso.
func NewGorm(db *gorm.DB) *Gorm {
	return &Gorm{db: db}
}

// AutoMigrate cria/atualiza o schema da tabela de licenças.
//
// ATENÇÃO — adequado apenas para desenvolvimento (MVP). Antes de
// produção, substitua por migrações versionadas (ex.: golang-migrate,
// atlas) executadas fora do processo da aplicação, conforme já
// registrado no README do projeto.
func (g *Gorm) AutoMigrate() error {
	return g.db.AutoMigrate(&licenseRecord{})
}

// Save cria ou atualiza (upsert por chave primária license_id) uma
// licença. GORM's Save já faz update-if-exists / insert-if-not quando
// a chave primária está preenchida.
func (g *Gorm) Save(ctx context.Context, lic license.License) error {
	record, err := toRecord(lic)
	if err != nil {
		return fmt.Errorf("codificando registro: %w", err)
	}
	if err := g.db.WithContext(ctx).Save(&record).Error; err != nil {
		return fmt.Errorf("gravando no banco: %w", err)
	}
	return nil
}

// FindByID busca uma licença pelo identificador primário. A checagem de
// correspondência com product_id/installation_id é responsabilidade do
// domínio (License.MatchesInstallation), não deste adaptador — o
// repositório só sabe buscar por chave, não aplicar regra de negócio.
func (g *Gorm) FindByID(ctx context.Context, licenseID, productID, installationID string) (license.License, error) {
	var record licenseRecord
	err := g.db.WithContext(ctx).First(&record, "license_id = ?", licenseID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return license.License{}, fmt.Errorf("licença %q: %w", licenseID, err)
	}
	if err != nil {
		return license.License{}, fmt.Errorf("consultando banco: %w", err)
	}
	return toDomain(record)
}

// compile-time check: Gorm deve satisfazer a porta license.Repository.
var _ license.Repository = (*Gorm)(nil)
