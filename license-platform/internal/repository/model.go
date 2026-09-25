package repository

import (
	"time"

	"github.com/example/license-platform/internal/license"
)

// licenseRecord é o modelo de persistência GORM. É deliberadamente um
// tipo à parte de license.License (ADR-02): tags de banco (`gorm:`),
// estratégia de serialização de mapas e a chave primária são detalhes
// do adaptador, não do domínio. O domínio nunca importa este pacote.
type licenseRecord struct {
	LicenseID      string `gorm:"primaryKey;column:license_id"`
	Version        int    `gorm:"column:version"`
	Issuer         string `gorm:"column:issuer"`
	Audience       string `gorm:"column:audience"`
	CustomerID     string `gorm:"column:customer_id;index"`
	ProductID      string `gorm:"column:product_id;index"`
	InstallationID string `gorm:"column:installation_id;index"`
	Status         string `gorm:"column:status"`

	// Mapas não têm representação nativa estável em SQL; são
	// persistidos como JSON serializado nesta borda do sistema. O
	// domínio continua trabalhando com map[string]bool / map[string]int64.
	FeaturesJSON string `gorm:"column:features_json"`
	LimitsJSON   string `gorm:"column:limits_json"`

	IssuedAt     time.Time `gorm:"column:issued_at"`
	ExpiresAt    time.Time `gorm:"column:expires_at;index"`
	LeaseUntil   time.Time `gorm:"column:lease_until"`
	OfflineUntil time.Time `gorm:"column:offline_until"`

	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

func (licenseRecord) TableName() string { return "licenses" }

// toRecord mapeia a entidade de domínio para o modelo de persistência.
func toRecord(lic license.License) (licenseRecord, error) {
	featuresJSON, err := encodeFeatures(lic.Features)
	if err != nil {
		return licenseRecord{}, err
	}
	limitsJSON, err := encodeLimits(lic.Limits)
	if err != nil {
		return licenseRecord{}, err
	}
	return licenseRecord{
		LicenseID:      lic.LicenseID,
		Version:        lic.Version,
		Issuer:         lic.Issuer,
		Audience:       lic.Audience,
		CustomerID:     lic.CustomerID,
		ProductID:      lic.ProductID,
		InstallationID: lic.InstallationID,
		Status:         string(lic.Status),
		FeaturesJSON:   featuresJSON,
		LimitsJSON:     limitsJSON,
		IssuedAt:       lic.IssuedAt,
		ExpiresAt:      lic.ExpiresAt,
		LeaseUntil:     lic.LeaseUntil,
		OfflineUntil:   lic.OfflineUntil,
	}, nil
}

// toDomain mapeia o modelo de persistência de volta para a entidade de
// domínio. É a única direção em que licenseRecord "sabe" sobre license.License —
// o inverso (License conhecer licenseRecord) nunca deve existir.
func toDomain(r licenseRecord) (license.License, error) {
	features, err := decodeFeatures(r.FeaturesJSON)
	if err != nil {
		return license.License{}, err
	}
	limits, err := decodeLimits(r.LimitsJSON)
	if err != nil {
		return license.License{}, err
	}
	return license.License{
		Version:        r.Version,
		Issuer:         r.Issuer,
		Audience:       r.Audience,
		LicenseID:      r.LicenseID,
		CustomerID:     r.CustomerID,
		ProductID:      r.ProductID,
		InstallationID: r.InstallationID,
		Status:         license.Status(r.Status),
		Features:       features,
		Limits:         limits,
		IssuedAt:       r.IssuedAt,
		ExpiresAt:      r.ExpiresAt,
		LeaseUntil:     r.LeaseUntil,
		OfflineUntil:   r.OfflineUntil,
	}, nil
}
