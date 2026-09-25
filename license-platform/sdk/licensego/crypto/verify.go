// Package crypto (do SDK) verifica a assinatura Ed25519 de um
// documento de licença recebido do servidor ou lido do cache local.
//
// Este pacote é deliberadamente independente de internal/crypto (o
// pacote de mesmo nome no módulo do servidor): o SDK é consumido por
// aplicações externas ao repositório do servidor, então não deve
// acoplar-se aos internos dele. A duplicação da chamada a
// ed25519.Verify é aceitável — é uma única linha da biblioteca padrão,
// e o acoplamento entre módulos seria um custo maior que a repetição.
package crypto

import (
	"crypto/ed25519"
	"errors"
)

var (
	ErrUnknownKeyID     = errors.New("key_id não corresponde a nenhuma chave pública confiável")
	ErrInvalidSignature = errors.New("assinatura inválida para o payload recebido")
)

// Verifier confere a assinatura de um documento contra o conjunto de
// chaves públicas que a aplicação cliente confia.
type Verifier struct {
	trustedKeys map[string]ed25519.PublicKey
}

func NewVerifier(trustedKeys map[string]ed25519.PublicKey) *Verifier {
	return &Verifier{trustedKeys: trustedKeys}
}

// Verify confirma que payload foi assinado pela chave privada
// correspondente a keyID, dentre as chaves públicas confiáveis. Um
// key_id desconhecido é tratado como erro distinto de assinatura
// inválida — útil para diagnosticar rotação de chave mal configurada
// (ver seção de diagnóstico do README do projeto).
func (v *Verifier) Verify(keyID string, payload, signature []byte) error {
	pub, ok := v.trustedKeys[keyID]
	if !ok {
		return ErrUnknownKeyID
	}
	if !ed25519.Verify(pub, payload, signature) {
		return ErrInvalidSignature
	}
	return nil
}
