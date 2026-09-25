package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/example/license-platform/internal/license"
)

// Handler agrupa as dependências HTTP. Note que ele depende dos
// serviços de domínio (*license.IssueService, *license.ValidateService),
// não de internal/repository nem internal/crypto diretamente — essas
// dependências transitivas já foram resolvidas na composição em
// cmd/license-server.
type Handler struct {
	issueService    *license.IssueService
	validateService *license.ValidateService
	logger          *log.Logger
}

func NewHandler(issueService *license.IssueService, validateService *license.ValidateService, logger *log.Logger) *Handler {
	if logger == nil {
		logger = log.Default()
	}
	return &Handler{issueService: issueService, validateService: validateService, logger: logger}
}

// Routes monta o multiplexer HTTP. Fica isolado aqui para que
// cmd/license-server só precise chamar Handler.Routes() e subir o
// servidor, sem conhecer os caminhos internos.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", h.handleHealth)
	mux.HandleFunc("POST /v1/licenses/issue", h.handleIssue)
	mux.HandleFunc("POST /v1/licenses/validate", h.handleValidate)
	return mux
}

func (h *Handler) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) handleIssue(w http.ResponseWriter, r *http.Request) {
	var req IssueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "corpo da requisição não é um JSON válido")
		return
	}

	lic, err := req.toDomain()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_payload", "formato de campo inválido (ex.: expires_at fora do padrão RFC3339)")
		return
	}

	signed, err := h.issueService.Issue(r.Context(), lic)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, toResponse(signed))
}

func (h *Handler) handleValidate(w http.ResponseWriter, r *http.Request) {
	var req ValidateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "corpo da requisição não é um JSON válido")
		return
	}

	signed, err := h.validateService.Validate(r.Context(), req.toDomain())
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, toResponse(signed))
}

// handleServiceError é o único lugar do sistema que traduz erros de
// domínio em status HTTP e mensagens públicas (ADR-04). Qualquer erro
// não reconhecido explicitamente cai no caso default como 500 genérico —
// o detalhe real vai para o log do servidor, nunca para a resposta.
func (h *Handler) handleServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, license.ErrInvalidPayload):
		writeError(w, http.StatusBadRequest, "invalid_payload", "dados da licença não passaram na validação")
	case errors.Is(err, license.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "licença não encontrada")
	case errors.Is(err, license.ErrInstallationMismatch):
		writeError(w, http.StatusForbidden, "installation_mismatch", "licença não corresponde à instalação informada")
	case errors.Is(err, license.ErrNotActive):
		writeError(w, http.StatusForbidden, "not_active", "licença não está ativa")
	case errors.Is(err, license.ErrExpired):
		writeError(w, http.StatusForbidden, "expired", "licença expirada")
	default:
		h.logger.Printf("erro interno não mapeado: %v", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "erro interno do servidor")
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, ErrorResponse{Code: code, Message: message})
}
