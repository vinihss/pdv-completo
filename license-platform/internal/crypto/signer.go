package crypto

import (
	"context"
	"crypto/ed25519"
	"fmt"
)

// Ed25519Signer implementa a porta license.Signer. Depende apenas da
// interface KeyProvider — não sabe, nem precisa saber, se a chave vem
// de memória, de um secret manager ou de um HSM.
type Ed25519Signer struct {
	keys KeyProvider
}

func NewEd25519Signer(keys KeyProvider) *Ed25519Signer {
	return &Ed25519Signer{keys: keys}
}

// Sign assina o payload com a chave privada corrente. O contexto é
// derivado internamente (context.Background) porque a porta
// license.Signer não recebe contexto — se a origem da chave passar a
// depender de uma chamada de rede com timeout, propague o contexto
// através de uma nova assinatura de método, avaliando o impacto nos
// consumidores da porta.
func (s *Ed25519Signer) Sign(payload []byte) ([]byte, string, error) {
	priv, keyID, err := s.keys.PrivateKey(context.Background())
	if err != nil {
		return nil, "", fmt.Errorf("obtendo chave privada: %w", err)
	}
	sig := ed25519.Sign(priv, payload)
	return sig, keyID, nil
}
