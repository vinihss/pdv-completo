package license

import (
	"context"
	"fmt"
	"time"
)

// IssueService orquestra a emissão de uma licença: valida o payload,
// persiste, assina e retorna o documento assinado. Depende apenas das
// portas do domínio — nunca de GORM, HTTP ou do pacote ed25519 diretamente.
type IssueService struct {
	repo   LicenseWriter
	signer Signer
	clock  Clock
}

// NewIssueService injeta as dependências explicitamente. Nenhuma
// variável global, nenhum init() — o chamador (cmd/license-server)
// decide quais implementações concretas usar.
func NewIssueService(repo LicenseWriter, signer Signer, clock Clock) *IssueService {
	return &IssueService{repo: repo, signer: signer, clock: clock}
}

// Issue valida, persiste e assina uma licença. Se IssuedAt não for
// informado pelo chamador, é preenchido com o relógio injetado — nunca
// com time.Now() direto, para manter o serviço testável.
func (s *IssueService) Issue(ctx context.Context, lic License) (SignedLicense, error) {
	if lic.IssuedAt.IsZero() {
		lic.IssuedAt = s.clock.Now()
	}
	if lic.Status == "" {
		lic.Status = StatusActive
	}
	if lic.LeaseHours != nil {
		lic.LeaseUntil = lic.IssuedAt.Add(time.Duration(*lic.LeaseHours * float64(time.Hour)))
		lic.LeaseHours = nil // parâmetro transiente já consumido, não deve ser persistido
	}

	if err := lic.Validate(); err != nil {
		return SignedLicense{}, fmt.Errorf("%w: %s", ErrInvalidPayload, err)
	}

	if err := s.repo.Save(ctx, lic); err != nil {
		return SignedLicense{}, fmt.Errorf("%w: %s", ErrPersistenceFailed, err)
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
