package crypto

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"sync"
)

// KeyProvider é a porta que separa "assinar" de "onde a chave privada
// vem de". Esta separação é o que permite trocar a origem da chave
// (memória → secret manager → HSM) sem alterar Ed25519Signer nem o
// domínio: apenas uma nova implementação desta interface.
type KeyProvider interface {
	// PrivateKey retorna a chave privada corrente e seu identificador.
	PrivateKey(ctx context.Context) (priv ed25519.PrivateKey, keyID string, err error)

	// PublicKey retorna a chave pública corrente e seu identificador,
	// usada para expor a chave publicamente (ex.: log de boot, endpoint
	// de descoberta de chaves).
	PublicKey(ctx context.Context) (pub ed25519.PublicKey, keyID string, err error)
}

// InMemoryKeyProvider gera um par de chaves Ed25519 em memória na
// primeira utilização e o mantém pelo tempo de vida do processo.
//
// ATENÇÃO — adequado apenas para desenvolvimento (MVP), conforme o
// README do projeto: a chave privada nunca é persistida e é
// regenerada a cada reinicialização, o que invalida a confiança
// operacional entre boots. Antes de produção, substitua por uma
// implementação que carregue a chave de um secret manager ou HSM,
// com suporte a rotação e versionamento — sem alterar nenhum
// consumidor desta interface.
type InMemoryKeyProvider struct {
	keyID string

	mu   sync.Mutex
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

// NewInMemoryKeyProvider recebe o identificador de chave (ex.: da
// variável de ambiente LICENSE_KEY_ID) e gera o par de chaves na hora.
func NewInMemoryKeyProvider(keyID string) (*InMemoryKeyProvider, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("gerando par de chaves ed25519: %w", err)
	}
	return &InMemoryKeyProvider{keyID: keyID, pub: pub, priv: priv}, nil
}

func (p *InMemoryKeyProvider) PrivateKey(ctx context.Context) (ed25519.PrivateKey, string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.priv, p.keyID, nil
}

func (p *InMemoryKeyProvider) PublicKey(ctx context.Context) (ed25519.PublicKey, string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.pub, p.keyID, nil
}
