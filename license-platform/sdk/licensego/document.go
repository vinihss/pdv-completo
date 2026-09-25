package licensego

import (
	"encoding/json"

	"github.com/example/license-platform/sdk/licensego/model"
)

// wireDocument espelha o formato canônico que o servidor assina (ver
// internal/license/canonical.go no módulo do servidor). Os dois lados
// precisam concordar neste formato de payload — é o contrato real do
// sistema, mais fundamental que o transporte HTTP em si, porque é o
// que está sob a assinatura Ed25519.
type wireDocument struct {
	Version        int              `json:"version"`
	Issuer         string           `json:"issuer"`
	Audience       string           `json:"aud,omitempty"`
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

func decodeDocument(payload []byte) (model.Document, error) {
	var w wireDocument
	if err := json.Unmarshal(payload, &w); err != nil {
		return model.Document{}, err
	}

	issuedAt, err := parseTimeLoose(w.IssuedAt)
	if err != nil {
		return model.Document{}, err
	}
	expiresAt, err := parseTimeLoose(w.ExpiresAt)
	if err != nil {
		return model.Document{}, err
	}
	leaseUntil, err := parseTimeLoose(w.LeaseUntil)
	if err != nil {
		return model.Document{}, err
	}
	offlineUntil, err := parseTimeLoose(w.OfflineUntil)
	if err != nil {
		return model.Document{}, err
	}

	return model.Document{
		LicenseID:      w.LicenseID,
		CustomerID:     w.CustomerID,
		ProductID:      w.ProductID,
		InstallationID: w.InstallationID,
		Status:         w.Status,
		Features:       w.Features,
		Limits:         w.Limits,
		IssuedAt:       issuedAt,
		ExpiresAt:      expiresAt,
		LeaseUntil:     leaseUntil,
		OfflineUntil:   offlineUntil,
	}, nil
}
