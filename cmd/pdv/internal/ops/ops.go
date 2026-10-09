// Package ops implementa as operações reais de gerenciamento de tenants.
// Estas funções são chamadas pela TUI e executam as ações via runner (local)
// ou SSH (remoto), seguindo o padrão definido em docs/15-multi-tenant-schema.md.
package ops

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"pdv-cli/internal/config"
	"pdv-cli/internal/runner"
)

// TenantInfo representa informações básicas de um tenant.
type TenantInfo struct {
	ID        int
	Slug      string
	Subdomain string
	Status    string
	CreatedAt string
}

// ListTenants lista todos os tenants do registry.
// Retorna slice de TenantInfo ou erro.
func ListTenants() ([]TenantInfo, error) {
	// Executa SQL para listar tenants via psql
	query := `SELECT id, slug, subdomain, status, created_at::text 
              FROM public.tenant 
              ORDER BY created_at DESC`

	cmd := exec.Command("psql", "${DATABASE_URL}", "-t", "-A", "-F", "|", "-c", query)
	cmd.Dir = filepath.Join(config.RootPath, "backend")

	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("erro ao listar tenants: %w", err)
	}

	// Parse output: cada linha é id|slug|subdomain|status|created_at
	var tenants []TenantInfo
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) != 5 {
			continue
		}

		id, _ := strconv.Atoi(parts[0])
		tenants = append(tenants, TenantInfo{
			ID:        id,
			Slug:      parts[1],
			Subdomain: parts[2],
			Status:    parts[3],
			CreatedAt: parts[4],
		})
	}

	return tenants, nil
}

// CreateTenant provisiona um novo tenant.
// Executa o script provision-tenant.ts do backend.
func CreateTenant(slug, displayName string) error {
	if slug == "" {
		return fmt.Errorf("slug é obrigatório")
	}
	if displayName == "" {
		displayName = slug
	}

	env := []string{
		"SLUG=" + slug,
		"DISPLAY_NAME=" + displayName,
	}

	code := runner.RunCmdWithEnv(
		filepath.Join(config.RootPath, "backend"),
		env,
		"npx", "--yes", "tsx", "src/infra/db/provision-tenant.ts", slug, displayName,
	)

	if code != 0 {
		return fmt.Errorf("provision falhou com código %d", code)
	}

	return nil
}

// SuspendTenant suspende um tenant (muda status para 'suspended').
func SuspendTenant(slug string) error {
	return updateTenantStatus(slug, "suspended")
}

// ReactivateTenant reativa um tenant (muda status para 'active').
func ReactivateTenant(slug string) error {
	return updateTenantStatus(slug, "active")
}

// updateTenantStatus atualiza o status de um tenant no registry.
func updateTenantStatus(slug, status string) error {
	query := fmt.Sprintf(
		`UPDATE public.tenant SET status = '%s' WHERE slug = '%s'`,
		status, slug,
	)

	cmd := exec.Command("psql", "${DATABASE_URL}", "-c", query)
	cmd.Dir = filepath.Join(config.RootPath, "backend")

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("erro ao atualizar status: %w\n%s", err, output)
	}

	return nil
}

// RemoveTenant remove um tenant do registry (NÃO remove o schema).
// Esta é uma operação perigosa e deve ser usada com cuidado.
func RemoveTenant(slug string) error {
	query := fmt.Sprintf(`DELETE FROM public.tenant WHERE slug = '%s'`, slug)

	cmd := exec.Command("psql", "${DATABASE_URL}", "-c", query)
	cmd.Dir = filepath.Join(config.RootPath, "backend")

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("erro ao remover tenant: %w\n%s", err, output)
	}

	return nil
}

// DropTenantSchema remove o schema do tenant (operaçãoo irreversível).
func DropTenantSchema(slug string) error {
	schemaName := "tenant_" + slug
	query := fmt.Sprintf(`DROP SCHEMA IF EXISTS %s CASCADE`, schemaName)

	cmd := exec.Command("psql", "${DATABASE_URL}", "-c", query)
	cmd.Dir = filepath.Join(config.RootPath, "backend")

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("erro ao remover schema: %w\n%s", err, output)
	}

	return nil
}

// ResetManagerPIN reseta o PIN do manager de um tenant.
// Se pin não for fornecido, gera um PIN aleatório de 4 dígitos.
func ResetManagerPIN(slug, pin string) (string, error) {
	if pin == "" {
		// Gera PIN aleatório de 4 dígitos
		pin = fmt.Sprintf("%04d", 1000+int(9000*0.5)) // TODO: usar crypto/rand
	}

	// Executa o script de reset de PIN
	code := runner.RunCmdWithEnv(
		filepath.Join(config.RootPath, "backend"),
		[]string{"SLUG=" + slug, "NEW_PIN=" + pin},
		"npx", "--yes", "tsx", "src/infra/db/reset-manager-pin.ts", slug, pin,
	)

	if code != 0 {
		return "", fmt.Errorf("reset de PIN falhou com código %d", code)
	}

	return pin, nil
}

// GetStoreConfig obtém as configurações da loja (store_settings).
func GetStoreConfig(slug string) (map[string]interface{}, error) {
	schemaName := "tenant_" + slug
	query := fmt.Sprintf(`SELECT settings FROM %s.store_settings`, schemaName)

	cmd := exec.Command("psql", "${DATABASE_URL}", "-t", "-A", "-c", query)
	cmd.Dir = filepath.Join(config.RootPath, "backend")

	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("erro ao obter configurações: %w", err)
	}

	var settings map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(output))), &settings); err != nil {
		return nil, fmt.Errorf("erro ao fazer parse do JSON: %w", err)
	}

	return settings, nil
}

// UpdateStoreConfig atualiza as configurações da loja.
func UpdateStoreConfig(slug string, settings map[string]interface{}) error {
	schemaName := "tenant_" + slug
	configJSON, err := json.Marshal(settings)
	if err != nil {
		return fmt.Errorf("erro ao serializar config: %w", err)
	}

	query := fmt.Sprintf(
		`UPDATE %s.store_settings SET settings = '%s'::jsonb`,
		schemaName, string(configJSON),
	)

	cmd := exec.Command("psql", "${DATABASE_URL}", "-c", query)
	cmd.Dir = filepath.Join(config.RootPath, "backend")

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("erro ao atualizar configurações: %w\n%s", err, output)
	}

	return nil
}

// CheckServices verifica o status dos serviços Docker.
func CheckServices() (map[string]string, error) {
	cmd := exec.Command("docker", "compose", "ps", "--format", "json")
	cmd.Dir = filepath.Join(config.RootPath, "deploy")

	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("erro ao verificar serviços: %w", err)
	}

	// Parse JSON output
	services := make(map[string]string)
	var containers []struct {
		Name  string `json:"Name"`
		State string `json:"State"`
	}

	if err := json.Unmarshal([]byte(output), &containers); err != nil {
		return nil, fmt.Errorf("erro ao fazer parse do output: %w", err)
	}

	for _, c := range containers {
		services[c.Name] = c.State
	}

	return services, nil
}

// DumpTenant faz um dump do schema do tenant.
func DumpTenant(slug, outputFile string) error {
	schemaName := "tenant_" + slug

	cmd := exec.Command("pg_dump", "${DATABASE_URL}",
		"--schema="+schemaName,
		"--file="+outputFile,
	)
	cmd.Dir = filepath.Join(config.RootPath, "backend")

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("erro ao fazer dump: %w\n%s", err, output)
	}

	return nil
}

// AddUser adiciona um novo usuário a um tenant.
// profile deve ser: waiter, kitchen, manager, cashier, courier
func AddUser(slug, name, profile, pin string) error {
	if slug == "" || name == "" || profile == "" {
		return fmt.Errorf("slug, nome e perfil são obrigatórios")
	}

	// Valida perfil
	validProfiles := map[string]bool{
		"waiter":   true,
		"kitchen":  true,
		"manager":  true,
		"cashier":  true,
		"courier":  true,
	}
	if !validProfiles[profile] {
		return fmt.Errorf("perfil inválido: %s (deve ser waiter, kitchen, manager, cashier ou courier)", profile)
	}

	// Se PIN não fornecido, gera um aleatório
	if pin == "" {
		pin = fmt.Sprintf("%04d", 1000+int(9000*0.5)) // TODO: usar crypto/rand
	}

	// Executa script de criação de usuário
	code := runner.RunCmdWithEnv(
		filepath.Join(config.RootPath, "backend"),
		[]string{
			"SLUG=" + slug,
			"USER_NAME=" + name,
			"USER_PROFILE=" + profile,
			"USER_PIN=" + pin,
		},
		"npx", "--yes", "tsx", "src/infra/db/add-user.ts", slug, name, profile, pin,
	)

	if code != 0 {
		return fmt.Errorf("adição de usuário falhou com código %d", code)
	}

	return nil
}
