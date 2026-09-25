package license

import (
	"errors"
	"time"
)

// Status representa o estado administrativo de uma licença, definido
// por quem emitiu — não confundir com o estado operacional (State),
// que é calculado pelo SDK cliente em função do tempo e do cache local.
type Status string

const (
	StatusActive    Status = "active"
	StatusSuspended Status = "suspended"
	StatusRevoked   Status = "revoked"
)

// License é a entidade central do domínio. Não conhece HTTP, banco de
// dados ou o formato de serialização usado para assinatura — isso é
// responsabilidade dos adaptadores.
type License struct {
	Version        int
	Issuer         string
	Audience       string
	LicenseID      string
	CustomerID     string
	ProductID      string
	InstallationID string
	Status         Status
	Features       map[string]bool
	Limits         map[string]int64
	IssuedAt       time.Time
	ExpiresAt      time.Time

	// Lease define até quando este documento assinado é considerado
	// "fresco" sem que o cliente precise revalidar com o servidor.
	LeaseUntil time.Time

	// OfflineUntil é o fim da janela de tolerância: o SDK pode aceitar
	// o cache local como válido mesmo sem contato com o servidor até
	// este instante, mesmo com o lease expirado (grace period).
	OfflineUntil time.Time

	// LeaseHours é um parâmetro transiente de entrada (não persistido):
	// quando informado na emissão, instrui IssueService a calcular
	// LeaseUntil = IssuedAt + LeaseHours, em vez do padrão (LeaseUntil
	// = ExpiresAt). É nil na leitura de uma licença já persistida.
	LeaseHours *float64
}

var (
	ErrMissingLicenseID      = errors.New("license_id é obrigatório")
	ErrMissingCustomerID     = errors.New("customer_id é obrigatório")
	ErrMissingProductID      = errors.New("product_id é obrigatório")
	ErrMissingInstallationID = errors.New("installation_id é obrigatório")
	ErrInvalidStatus         = errors.New("status inválido")
	ErrExpiresBeforeIssued   = errors.New("expires_at não pode ser anterior a issued_at")
	ErrLeaseAfterExpiry      = errors.New("lease_until não pode ser posterior a expires_at")
)

// Validate aplica as invariantes de domínio. É chamado pelos serviços de
// aplicação antes de qualquer persistência ou assinatura — nunca confie
// em payload vindo de fora sem passar por aqui primeiro.
func (l License) Validate() error {
	if l.LicenseID == "" {
		return ErrMissingLicenseID
	}
	if l.CustomerID == "" {
		return ErrMissingCustomerID
	}
	if l.ProductID == "" {
		return ErrMissingProductID
	}
	if l.InstallationID == "" {
		return ErrMissingInstallationID
	}
	switch l.Status {
	case StatusActive, StatusSuspended, StatusRevoked:
	default:
		return ErrInvalidStatus
	}
	if l.ExpiresAt.Before(l.IssuedAt) {
		return ErrExpiresBeforeIssued
	}
	if !l.LeaseUntil.IsZero() && l.LeaseUntil.After(l.ExpiresAt) {
		return ErrLeaseAfterExpiry
	}
	return nil
}

// IsExpired informa se a licença já passou da validade, em relação ao
// instante `now` — sempre injetado pelo chamador (ver porta Clock),
// nunca lido diretamente de time.Now() dentro do domínio.
func (l License) IsExpired(now time.Time) bool {
	return now.After(l.ExpiresAt)
}

// MatchesInstallation confirma se a licença corresponde ao produto e à
// instalação informados na requisição de validação.
func (l License) MatchesInstallation(productID, installationID string) bool {
	return l.ProductID == productID && l.InstallationID == installationID
}

// HasFeature responde se uma feature está habilitada. Ausência no mapa
// é tratada como "não habilitada", nunca como erro.
func (l License) HasFeature(name string) bool {
	return l.Features[name]
}

// Limit retorna um limite configurado e um booleano indicando se ele
// foi de fato definido nesta licença (para distinguir "0" de "ausente").
func (l License) Limit(name string) (int64, bool) {
	v, ok := l.Limits[name]
	return v, ok
}

// SignedLicense é o resultado de uma assinatura: o payload canônico e a
// assinatura Ed25519 sobre ele, junto com o identificador da chave usada.
type SignedLicense struct {
	KeyID     string
	Payload   []byte
	Signature []byte
}
