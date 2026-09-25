// Package licensego é o SDK cliente do License Platform. A aplicação
// que consome uma licença só precisa deste pacote: ele encapsula a
// comunicação com o servidor, a verificação da assinatura Ed25519 e o
// cache local para operação offline, sem expor esses detalhes de
// transporte ao código de negócio da aplicação cliente.
package licensego

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/example/license-platform/sdk/licensego/cache"
	sdkcrypto "github.com/example/license-platform/sdk/licensego/crypto"
	"github.com/example/license-platform/sdk/licensego/model"
)

// Client é a fachada única do SDK. Todos os campos são obrigatórios,
// exceto onde indicado.
type Client struct {
	// BaseURL é o endereço do License Platform (ex.: "http://localhost:8080").
	BaseURL string

	LicenseID      string
	ProductID      string
	InstallationID string

	// PublicKeys mapeia key_id -> chave pública confiável. Um
	// documento assinado com um key_id ausente deste mapa é rejeitado
	// (ver sdk/licensego/crypto.ErrUnknownKeyID) — isso é o que torna
	// a rotação de chave no servidor uma operação explícita também do
	// lado do cliente, nunca automática.
	PublicKeys map[string]ed25519.PublicKey

	// Cache é onde o último documento assinado válido é persistido
	// localmente. Use cache.FileStore para o caso comum, ou qualquer
	// implementação própria de cache.Store.
	Cache cache.Store

	// HTTPClient é opcional; se nil, um *http.Client com timeout
	// padrão de 10s é usado. Permite à aplicação cliente configurar
	// proxy, TLS customizado, etc.
	HTTPClient *http.Client

	// Now é opcional; se nil, time.Now é usado. Permite testar a
	// aplicação cliente com tempo controlado.
	Now func() time.Time
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Check retorna o estado operacional corrente da licença. Tenta
// consultar o servidor; se indisponível, cai para o cache local
// dentro da janela de tolerância offline (ver computeState).
func (c *Client) Check(ctx context.Context) (model.CheckResult, error) {
	entry, fetchErr := c.fetchFromServer(ctx)
	serverReached := fetchErr == nil

	if serverReached {
		if err := c.Cache.Save(entry); err != nil {
			// Falha ao gravar cache não invalida uma resposta que
			// acabou de ser verificada com sucesso — apenas registra;
			// a próxima chamada tentará novamente.
			_ = err
		}
	} else {
		cached, loadErr := c.Cache.Load()
		if loadErr != nil {
			return model.CheckResult{State: model.StateInvalid, Valid: false}, nil
		}
		entry = cached
	}

	doc, err := c.verifyAndDecode(entry)
	if err != nil {
		return model.CheckResult{State: model.StateInvalid, Valid: false}, nil
	}

	state := computeState(doc, c.now(), serverReached)
	return model.CheckResult{
		State:    state,
		Document: doc,
		Valid:    state == model.StateActive || state == model.StateGracePeriod || state == model.StateOffline,
	}, nil
}

// Refresh força uma consulta ao servidor, ignorando qualquer cache
// ainda dentro do lease. Útil antes de uma operação importante em que
// a aplicação prefere pagar o custo de rede a confiar no cache.
func (c *Client) Refresh(ctx context.Context) error {
	entry, err := c.fetchFromServer(ctx)
	if err != nil {
		return fmt.Errorf("consultando servidor: %w", err)
	}
	if _, err := c.verifyAndDecode(entry); err != nil {
		return fmt.Errorf("verificando documento recebido: %w", err)
	}
	return c.Cache.Save(entry)
}

// validateHTTPRequest e validateHTTPResponse espelham os DTOs do
// servidor (internal/api/dto.go). São definidos aqui, no SDK, e não
// importados do módulo do servidor — os dois lados do contrato HTTP
// evoluem de forma independente (ADR-02 aplicado também à fronteira
// entre módulos, não só entre camadas).
type validateHTTPRequest struct {
	LicenseID      string `json:"license_id"`
	ProductID      string `json:"product_id"`
	InstallationID string `json:"installation_id"`
}

type signedLicenseHTTPResponse struct {
	KeyID     string `json:"key_id"`
	Payload   []byte `json:"payload"`
	Signature []byte `json:"signature"`
}

func (c *Client) fetchFromServer(ctx context.Context) (cache.Entry, error) {
	reqBody, err := json.Marshal(validateHTTPRequest{
		LicenseID:      c.LicenseID,
		ProductID:      c.ProductID,
		InstallationID: c.InstallationID,
	})
	if err != nil {
		return cache.Entry{}, fmt.Errorf("codificando requisição: %w", err)
	}

	url := c.BaseURL + "/v1/licenses/validate"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return cache.Entry{}, fmt.Errorf("montando requisição: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient().Do(httpReq)
	if err != nil {
		return cache.Entry{}, fmt.Errorf("chamando servidor: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return cache.Entry{}, fmt.Errorf("servidor retornou status %d", resp.StatusCode)
	}

	var parsed signedLicenseHTTPResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return cache.Entry{}, fmt.Errorf("decodificando resposta: %w", err)
	}

	return cache.Entry{KeyID: parsed.KeyID, Payload: parsed.Payload, Signature: parsed.Signature}, nil
}

func (c *Client) verifyAndDecode(entry cache.Entry) (model.Document, error) {
	verifier := sdkcrypto.NewVerifier(c.PublicKeys)
	if err := verifier.Verify(entry.KeyID, entry.Payload, entry.Signature); err != nil {
		return model.Document{}, fmt.Errorf("assinatura não confiável: %w", err)
	}
	doc, err := decodeDocument(entry.Payload)
	if err != nil {
		return model.Document{}, fmt.Errorf("decodificando payload: %w", err)
	}
	return doc, nil
}
