package api

import (
	"time"

	"github.com/example/license-platform/internal/license"
)

// IssueRequest é o contrato JSON público do endpoint de emissão.
// Deliberadamente um tipo à parte de license.License (ADR-02): o
// schema HTTP pode evoluir (novos campos opcionais, versionamento)
// sem forçar mudanças na entidade de domínio, e vice-versa.
type IssueRequest struct {
	Version        int              `json:"version"`
	Issuer         string           `json:"issuer"`
	Audience       string           `json:"aud"`
	LicenseID      string           `json:"license_id"`
	CustomerID     string           `json:"customer_id"`
	ProductID      string           `json:"product_id"`
	InstallationID string           `json:"installation_id"`
	Status         string           `json:"status"`
	Features       []string         `json:"features"`
	Limits         map[string]int64 `json:"limits"`
	ExpiresAt      string           `json:"expires_at"`

	// LeaseHours define, a partir de issued_at, por quanto tempo o
	// documento assinado é considerado "fresco" sem revalidação
	// (ver estado "active" no SDK). Se omitido, o lease dura até
	// expires_at — ou seja, não há janela de revalidação forçada
	// separada da própria validade da licença.
	LeaseHours *float64 `json:"lease_hours,omitempty"`

	// OfflineHours define, a partir de expires_at, a tolerância
	// adicional em que o SDK ainda aceita o cache local mesmo sem
	// contato com o servidor (grace period). Se omitido, usa um
	// padrão de 7 dias (168h).
	OfflineHours *float64 `json:"offline_hours,omitempty"`
}

const defaultOfflineHours = 168 // 7 dias

// toDomain mapeia o DTO HTTP para a entidade de domínio, incluindo o
// parsing de formato (ex.: RFC3339 para ExpiresAt, slice de strings
// para o mapa de features). Erros de formato viram license.ErrInvalidPayload
// no handler, nunca vazam como panic ou erro cru de parsing.
func (r IssueRequest) toDomain() (license.License, error) {
	status := license.Status(r.Status)
	if r.Status == "" {
		status = license.StatusActive
	}

	features := make(map[string]bool, len(r.Features))
	for _, f := range r.Features {
		features[f] = true
	}

	var expiresAt time.Time
	if r.ExpiresAt != "" {
		parsed, err := time.Parse(time.RFC3339, r.ExpiresAt)
		if err != nil {
			return license.License{}, err
		}
		expiresAt = parsed
	}

	// LeaseUntil, por padrão, coincide com expires_at: o documento é
	// considerado "fresco" (estado "active") por toda a validade
	// nominal da licença, a menos que lease_hours seja informado para
	// forçar uma janela de revalidação mais curta a partir da emissão
	// (calculada pelo serviço de domínio, que conhece issued_at).
	offlineHours := defaultOfflineHours
	if r.OfflineHours != nil {
		offlineHours = int(*r.OfflineHours)
	}

	lic := license.License{
		Version:        r.Version,
		Issuer:         r.Issuer,
		Audience:       r.Audience,
		LicenseID:      r.LicenseID,
		CustomerID:     r.CustomerID,
		ProductID:      r.ProductID,
		InstallationID: r.InstallationID,
		Status:         status,
		Features:       features,
		Limits:         r.Limits,
		ExpiresAt:      expiresAt,
		LeaseUntil:     expiresAt,
		OfflineUntil:   expiresAt.Add(time.Duration(offlineHours) * time.Hour),
		LeaseHours:     r.LeaseHours,
	}

	return lic, nil
}

// ValidateRequest é o contrato JSON público do endpoint de validação.
type ValidateRequest struct {
	LicenseID      string `json:"license_id"`
	ProductID      string `json:"product_id"`
	InstallationID string `json:"installation_id"`
}

func (r ValidateRequest) toDomain() license.ValidateRequest {
	return license.ValidateRequest{
		LicenseID:      r.LicenseID,
		ProductID:      r.ProductID,
		InstallationID: r.InstallationID,
	}
}

// SignedLicenseResponse é a resposta pública para emissão e validação:
// o payload assinado e a assinatura, ambos serializados como bytes em
// JSON (base64 automático pelo encoding/json do Go para []byte).
type SignedLicenseResponse struct {
	KeyID     string `json:"key_id"`
	Payload   []byte `json:"payload"`
	Signature []byte `json:"signature"`
}

func toResponse(signed license.SignedLicense) SignedLicenseResponse {
	return SignedLicenseResponse{
		KeyID:     signed.KeyID,
		Payload:   signed.Payload,
		Signature: signed.Signature,
	}
}

// ErrorResponse é o formato uniforme de erro retornado pela API. O
// campo Code é estável e pensado para ser tratado programaticamente
// pelo cliente; Message é apenas para humanos e nunca deve conter
// detalhes internos (ver ADR-04).
type ErrorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
