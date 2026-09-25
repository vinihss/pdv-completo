package crypto

import (
	"crypto/ed25519"
	"errors"
)

// ErrInvalidSignature é retornado quando a assinatura não corresponde
// ao payload sob a chave pública informada.
var ErrInvalidSignature = errors.New("assinatura inválida")

// Verify confere uma assinatura Ed25519 sobre um payload com uma chave
// pública específica. É uma função pura, sem estado — usada tanto por
// testes do servidor quanto como referência para a verificação
// equivalente implementada no SDK cliente (sdk/licensego/crypto), que
// deliberadamente não importa este pacote para não acoplar o SDK ao
// módulo do servidor.
func Verify(pub ed25519.PublicKey, payload, signature []byte) error {
	if !ed25519.Verify(pub, payload, signature) {
		return ErrInvalidSignature
	}
	return nil
}
