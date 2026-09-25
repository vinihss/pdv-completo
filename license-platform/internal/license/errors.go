package license

import "errors"

// Erros de domínio. Apenas o adaptador HTTP (internal/api) deve traduzir
// estes erros em respostas concretas — o domínio nunca formata mensagens
// para o usuário final nem expõe detalhes de implementação.
var (
	// ErrInvalidPayload cobre falhas de validação de entrada (ver License.Validate).
	ErrInvalidPayload = errors.New("payload de licença inválido")

	// ErrNotFound é retornado quando nenhuma licença corresponde aos
	// identificadores informados.
	ErrNotFound = errors.New("licença não encontrada")

	// ErrInstallationMismatch é retornado quando a licença existe, mas
	// não corresponde ao product_id/installation_id da requisição.
	ErrInstallationMismatch = errors.New("licença não corresponde à instalação informada")

	// ErrNotActive é retornado quando a licença existe mas seu status
	// administrativo não é "active" (ex.: suspensa ou revogada).
	ErrNotActive = errors.New("licença não está ativa")

	// ErrExpired é retornado quando a licença passou da validade.
	ErrExpired = errors.New("licença expirada")

	// ErrSigningFailed cobre qualquer falha ao assinar o documento —
	// nunca deve vazar o motivo exato (ex.: problema com HSM) para fora
	// do processo do servidor.
	ErrSigningFailed = errors.New("falha ao assinar a licença")

	// ErrPersistenceFailed cobre qualquer falha de leitura/escrita no
	// repositório subjacente.
	ErrPersistenceFailed = errors.New("falha ao persistir a licença")
)
