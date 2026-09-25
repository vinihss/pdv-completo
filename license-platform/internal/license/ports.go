package license

import (
	"context"
	"time"
)

// LicenseReader é a porta de leitura de licenças. Serviços que apenas
// consultam (ex.: ValidateService) devem depender só desta interface,
// nunca de Repository inteiro — isso documenta, pelo próprio tipo, que
// o serviço não escreve no repositório.
type LicenseReader interface {
	FindByID(ctx context.Context, licenseID, productID, installationID string) (License, error)
}

// LicenseWriter é a porta de escrita de licenças.
type LicenseWriter interface {
	Save(ctx context.Context, lic License) error
}

// Repository agrega leitura e escrita. Implementada por um adaptador de
// persistência (ex.: internal/repository, via GORM/SQLite) que o
// domínio nunca importa diretamente.
type Repository interface {
	LicenseReader
	LicenseWriter
}

// Signer é a porta de assinatura. Implementada por internal/crypto.
// O domínio conhece apenas "assine estes bytes", não como a chave é
// obtida nem qual algoritmo é usado por baixo.
type Signer interface {
	Sign(payload []byte) (signature []byte, keyID string, err error)
}

// Clock é a porta de tempo. Permite que os serviços de domínio sejam
// testados de forma determinística, sem depender de time.Now() real.
type Clock interface {
	Now() time.Time
}

// RealClock é a implementação de produção de Clock, usada apenas na
// composição em cmd/license-server.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }
