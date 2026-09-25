package license

import (
	"context"
	"fmt"
)

// ValidateService orquestra a validação: busca a licença, confere
// instalação/status/expiração e retorna um novo documento assinado
// para o cliente armazenar em cache. Depende apenas de LicenseReader —
// nunca escreve no repositório, o que é garantido pelo próprio tipo.
type ValidateService struct {
	repo   LicenseReader
	signer Signer
	clock  Clock
}

func NewValidateService(repo LicenseReader, signer Signer, clock Clock) *ValidateService {
	return &ValidateService{repo: repo, signer: signer, clock: clock}
}

// ValidateRequest são os identificadores mínimos necessários para
// localizar e conferir uma licença.
type ValidateRequest struct {
	LicenseID      string
	ProductID      string
	InstallationID string
}

// Validate confere a licença e retorna um documento recém-assinado em
// caso de sucesso. A ordem das checagens importa: existência antes de
// instalação, instalação antes de status, status antes de expiração —
// cada uma produz um erro de domínio distinto para o handler traduzir.
func (s *ValidateService) Validate(ctx context.Context, req ValidateRequest) (SignedLicense, error) {
	lic, err := s.repo.FindByID(ctx, req.LicenseID, req.ProductID, req.InstallationID)
	if err != nil {
		return SignedLicense{}, fmt.Errorf("%w: %s", ErrNotFound, err)
	}

	if !lic.MatchesInstallation(req.ProductID, req.InstallationID) {
		return SignedLicense{}, ErrInstallationMismatch
	}

	if lic.Status != StatusActive {
		return SignedLicense{}, ErrNotActive
	}

	if lic.IsExpired(s.clock.Now()) {
		return SignedLicense{}, ErrExpired
	}

	payload, err := canonicalEncode(lic)
	if err != nil {
		return SignedLicense{}, fmt.Errorf("%w: %s", ErrSigningFailed, err)
	}

	sig, keyID, err := s.signer.Sign(payload)
	if err != nil {
		return SignedLicense{}, fmt.Errorf("%w: %s", ErrSigningFailed, err)
	}

	return SignedLicense{KeyID: keyID, Payload: payload, Signature: sig}, nil
}
