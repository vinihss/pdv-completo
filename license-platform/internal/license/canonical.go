package license

import (
	"encoding/json"
	"time"
)

// payloadDoc é a representação serializável e determinística de uma
// License. encoding/json do Go já garante ordem estável: campos de
// struct seguem a ordem de declaração, e chaves de map são ordenadas
// alfabeticamente — por isso não é necessário um encoder canônico
// customizado, apenas fixar este formato de payload.
type payloadDoc struct {
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
	IssuedAt       time.Time        `json:"issued_at"`
	ExpiresAt      time.Time        `json:"expires_at"`
	LeaseUntil     time.Time        `json:"lease_until,omitempty"`
	OfflineUntil   time.Time        `json:"offline_until,omitempty"`
}

// canonicalEncode serializa a licença no formato exato que é assinado
// e verificado. Qualquer mudança neste formato invalida assinaturas
// emitidas anteriormente — trate como um contrato versionado (ver
// campo Version dentro do próprio payload).
func canonicalEncode(l License) ([]byte, error) {
	doc := payloadDoc{
		Version:        l.Version,
		Issuer:         l.Issuer,
		Audience:       l.Audience,
		LicenseID:      l.LicenseID,
		CustomerID:     l.CustomerID,
		ProductID:      l.ProductID,
		InstallationID: l.InstallationID,
		Status:         string(l.Status),
		Features:       l.Features,
		Limits:         l.Limits,
		IssuedAt:       l.IssuedAt.UTC(),
		ExpiresAt:      l.ExpiresAt.UTC(),
		LeaseUntil:     l.LeaseUntil.UTC(),
		OfflineUntil:   l.OfflineUntil.UTC(),
	}
	return json.Marshal(doc)
}

// CanonicalDecode reconstrói uma License a partir de um payload
// canônico. Usado pelo SDK cliente após verificar a assinatura, e
// pelo próprio servidor ao reidratar um documento previamente assinado.
func CanonicalDecode(payload []byte) (License, error) {
	var doc payloadDoc
	if err := json.Unmarshal(payload, &doc); err != nil {
		return License{}, err
	}
	return License{
		Version:        doc.Version,
		Issuer:         doc.Issuer,
		Audience:       doc.Audience,
		LicenseID:      doc.LicenseID,
		CustomerID:     doc.CustomerID,
		ProductID:      doc.ProductID,
		InstallationID: doc.InstallationID,
		Status:         Status(doc.Status),
		Features:       doc.Features,
		Limits:         doc.Limits,
		IssuedAt:       doc.IssuedAt,
		ExpiresAt:      doc.ExpiresAt,
		LeaseUntil:     doc.LeaseUntil,
		OfflineUntil:   doc.OfflineUntil,
	}, nil
}
