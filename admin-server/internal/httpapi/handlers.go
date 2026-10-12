package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"pdv-admin-server/internal/settings"
	"pdv-admin-server/internal/tenants"
)

// slugPattern é a mesma regra do registry (`public.tenant` CHECK) e do
// provision-tenant.ts.
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// maxBodyBytes limita o corpo das requisições. Os corpos são minúsculos.
const maxBodyBytes = 1 << 20

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "ok",
		"version":       s.deps.Version,
		"uptimeSeconds": int(time.Since(s.deps.Started).Seconds()),
	})
}

func (s *Server) handleListTenants(w http.ResponseWriter, r *http.Request) {
	list, err := s.deps.Tenants.ListTenants(r.Context())
	if err != nil {
		log.Printf("[httpapi] listar tenants: %v", err)
		writeError(w, http.StatusInternalServerError, "internal", "falha ao listar tenants")
		return
	}
	if list == nil {
		list = []tenants.Tenant{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenants": list})
}

func (s *Server) handleCreateTenant(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Slug        string `json:"slug"`
		DisplayName string `json:"display_name"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	slug := strings.TrimSpace(body.Slug)
	if !slugPattern.MatchString(slug) {
		writeError(w, http.StatusBadRequest, "invalid_slug", "slug inválido: use letras minúsculas, números e hífen")
		return
	}
	displayName := strings.TrimSpace(body.DisplayName)
	if displayName == "" {
		displayName = slug
	}

	pin, err := s.deps.Provisioner.Provision(r.Context(), slug, displayName)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "provision_failed", provisionMessage(err))
		return
	}

	// O script grava a linha no registry; buscamos para devolver o mesmo shape
	// dos outros endpoints.
	t, found, err := s.deps.Tenants.GetTenant(r.Context(), slug)
	if err != nil {
		log.Printf("[httpapi] tenant %q provisionado, mas leitura falhou: %v", slug, err)
		writeError(w, http.StatusInternalServerError, "provision_failed", "tenant provisionado, mas o registry não pôde ser lido")
		return
	}
	if !found {
		writeError(w, http.StatusInternalServerError, "provision_failed", "tenant provisionado, mas não encontrado no registry")
		return
	}

	// O PIN volta exatamente uma vez, aqui. Nunca é logado nem gravado.
	writeJSON(w, http.StatusCreated, map[string]any{
		"tenant":      t,
		"manager_pin": pin,
	})
}

func (s *Server) handleRenameTenant(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")

	var body struct {
		DisplayName string `json:"display_name"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.DisplayName)
	if name == "" {
		writeError(w, http.StatusBadRequest, "invalid_display_name", "display_name é obrigatório")
		return
	}

	t, found, err := s.deps.Tenants.UpdateTenantName(r.Context(), slug, name)
	if err != nil {
		log.Printf("[httpapi] renomear tenant %q: %v", slug, err)
		writeError(w, http.StatusInternalServerError, "internal", "falha ao renomear tenant")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not_found", "tenant não encontrado")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenant": t})
}

func (s *Server) handleTenantStatus(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")

	var body struct {
		Status string `json:"status"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Status != "active" && body.Status != "suspended" {
		writeError(w, http.StatusBadRequest, "invalid_status", "status deve ser \"active\" ou \"suspended\"")
		return
	}

	t, found, err := s.deps.Tenants.UpdateTenantStatus(r.Context(), slug, body.Status)
	if err != nil {
		log.Printf("[httpapi] status tenant %q: %v", slug, err)
		writeError(w, http.StatusInternalServerError, "internal", "falha ao alterar status")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not_found", "tenant não encontrado")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenant": t})
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")

	st, found, err := s.deps.Settings.GetSettings(r.Context(), slug)
	if err != nil {
		log.Printf("[httpapi] settings de %q: %v", slug, err)
		writeError(w, http.StatusInternalServerError, "internal", "falha ao ler configurações")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not_found", "tenant não encontrado")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": st})
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")

	raw, ok := decodeObject(w, r)
	if !ok {
		return
	}
	patch, perr := settings.ParsePatch(raw)
	if perr != nil {
		var pe *settings.PatchError
		if errors.As(perr, &pe) {
			writeError(w, http.StatusBadRequest, pe.Code, pe.Message)
		} else {
			writeError(w, http.StatusBadRequest, "invalid_body", "corpo inválido")
		}
		return
	}

	st, found, err := s.deps.Settings.UpdateSettings(r.Context(), slug, patch)
	if err != nil {
		log.Printf("[httpapi] atualizar settings de %q: %v", slug, err)
		writeError(w, http.StatusInternalServerError, "internal", "falha ao atualizar configurações")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not_found", "tenant não encontrado")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": st})
}

func (s *Server) handleCacheClear(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Cache.Flush(r.Context()); err != nil {
		log.Printf("[httpapi] limpar cache: %v", err)
		writeError(w, http.StatusInternalServerError, "internal", "falha ao limpar cache")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"flushed": true})
}

func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Target string `json:"target"`
	}
	if !decodeOptionalJSON(w, r, &body) {
		return
	}
	target := body.Target
	if target == "" {
		target = "all"
	}
	switch target {
	case "db", "files", "all":
	default:
		writeError(w, http.StatusBadRequest, "invalid_target", "target deve ser \"db\", \"files\" ou \"all\"")
		return
	}

	paths, err := s.deps.Backup.Backup(r.Context(), target)
	if err != nil {
		if errors.Is(err, tenants.ErrNotConfigured) {
			writeError(w, http.StatusServiceUnavailable, "not_configured", "backup não configurado (PDV_DEPLOY_DIR vazio)")
			return
		}
		writeError(w, http.StatusInternalServerError, "backup_failed", backupMessage(err))
		return
	}
	if paths == nil {
		paths = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"target": target, "paths": paths})
}

// provisionMessage extrai a saída do script para a resposta 500, sem nunca
// incluir o PIN — o script só imprime o PIN no caminho de sucesso.
func provisionMessage(err error) string {
	var pe *tenants.ProvisionError
	if errors.As(err, &pe) && pe.Output != "" {
		return pe.Output
	}
	return "falha ao provisionar tenant"
}

func backupMessage(err error) string {
	var be *tenants.BackupError
	if errors.As(err, &be) && be.Output != "" {
		return be.Output
	}
	return "falha ao executar backup"
}

// decodeJSON decodifica um corpo JSON obrigatório. Devolve false já tendo
// escrito o 400.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err := dec.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "corpo JSON inválido")
		return false
	}
	return true
}

// decodeOptionalJSON aceita corpo vazio (usa os defaults de dst).
func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	body, err := readBody(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "corpo inválido")
		return false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return true
	}
	if err := json.Unmarshal(trimmed, dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "corpo JSON inválido")
		return false
	}
	return true
}

// decodeObject lê o corpo como um objeto JSON de campos arbitrários. Corpo
// vazio vira objeto vazio.
func decodeObject(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	body, err := readBody(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "corpo inválido")
		return nil, false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return map[string]json.RawMessage{}, true
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "corpo deve ser um objeto JSON")
		return nil, false
	}
	return raw, true
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	return io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
}
