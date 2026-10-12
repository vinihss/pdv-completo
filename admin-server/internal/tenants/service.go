// Package tenants concentra o domínio de tenants: o tipo devolvido pela API e
// os dois processos externos que o admin-server dispara — o provisioning (via
// docker exec) e o backup (via deploy/backup.sh).
//
// O PIN do manager nasce aqui, no stdout do script, e nunca é logado nem
// gravado: atravessa só a resposta HTTP da criação.
package tenants

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Tenant espelha uma linha de `public.tenant`. NÃO há `id`: a chave do registry
// é o slug.
type Tenant struct {
	Slug         string  `json:"slug"`
	SchemaName   string  `json:"schema_name"`
	DisplayName  string  `json:"display_name"`
	Status       string  `json:"status"`
	CustomDomain *string `json:"custom_domain"`
	CreatedAt    string  `json:"created_at"`
}

// ExecRunner abstrai a execução de processos externos, para o serviço poder ser
// testado sem docker nem shell.
type ExecRunner interface {
	Run(ctx context.Context, dir, name string, args ...string) (stdout, stderr string, err error)
}

type osRunner struct{}

func (osRunner) Run(ctx context.Context, dir, name string, args ...string) (string, string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

const (
	provisionTimeout = 5 * time.Minute
	backupTimeout    = 15 * time.Minute
	// maxOutputLen limita o texto do erro devolvido na resposta HTTP: stdout de
	// script pode ser enorme, e a mensagem é só para diagnóstico.
	maxOutputLen = 2000
)

// ErrNotConfigured indica que PDV_DEPLOY_DIR não foi definido.
var ErrNotConfigured = errors.New("backup não configurado")

// ProvisionError carrega a saída do script que falhou, para a resposta 500.
type ProvisionError struct {
	Output string
	Err    error
}

func (e *ProvisionError) Error() string {
	return fmt.Sprintf("provisioning falhou: %v", e.Err)
}

func (e *ProvisionError) Unwrap() error { return e.Err }

// BackupError carrega a saída do backup.sh que falhou.
type BackupError struct {
	Output string
	Err    error
}

func (e *BackupError) Error() string {
	return fmt.Sprintf("backup falhou: %v", e.Err)
}

func (e *BackupError) Unwrap() error { return e.Err }

// Service provisiona tenants em um container do backend.
type Service struct {
	runner    ExecRunner
	container string
	timeout   time.Duration
}

// NewService cria o provisionador que roda contra `container`.
func NewService(container string) *Service {
	return &Service{runner: osRunner{}, container: container, timeout: provisionTimeout}
}

// NewServiceWithRunner é usado pelos testes para injetar um runner falso.
func NewServiceWithRunner(runner ExecRunner, container string, timeout time.Duration) *Service {
	return &Service{runner: runner, container: container, timeout: timeout}
}

// Provision cria o tenant e devolve o PIN do manager (vazio se o script não o
// imprimiu). O timeout cobre migrations + seed dentro do container.
func (s *Service) Provision(ctx context.Context, slug, displayName string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	stdout, stderr, err := s.runner.Run(ctx, "",
		"docker", "exec", s.container, "node", "dist/infra/db/provision-tenant.js", slug, displayName)
	if err != nil {
		return "", &ProvisionError{
			Output: truncate(combine(stdout, stderr), maxOutputLen),
			Err:    err,
		}
	}

	pin, _ := PinFromOutput(stdout)
	return pin, nil
}

// BackupService roda deploy/backup.sh e devolve os caminhos produzidos.
type BackupService struct {
	runner    ExecRunner
	deployDir string
	timeout   time.Duration
}

// NewBackupService cria o serviço apontando para o deploy/ do checkout. Vazio
// deixa o endpoint em 503 `not_configured`.
func NewBackupService(deployDir string) *BackupService {
	return &BackupService{runner: osRunner{}, deployDir: deployDir, timeout: backupTimeout}
}

// NewBackupServiceWithRunner é usado pelos testes.
func NewBackupServiceWithRunner(runner ExecRunner, deployDir string, timeout time.Duration) *BackupService {
	return &BackupService{runner: runner, deployDir: deployDir, timeout: timeout}
}

// Backup executa o script e filtra os caminhos pelo target pedido. O script
// SEMPRE produz os dois artefatos (dump + uploads); o target só escolhe o que
// é reportado.
func (s *BackupService) Backup(ctx context.Context, target string) ([]string, error) {
	if s.deployDir == "" {
		return nil, ErrNotConfigured
	}

	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	script := filepath.Join(s.deployDir, "backup.sh")
	stdout, stderr, err := s.runner.Run(ctx, s.deployDir, "bash", script)
	if err != nil {
		return nil, &BackupError{
			Output: truncate(combine(stdout, stderr), maxOutputLen),
			Err:    err,
		}
	}

	return filterPaths(parseBackupPaths(stdout), target), nil
}

// parseBackupPaths coleta o que segue `-> ` em cada linha. O backup.sh imprime
// "Backup do banco ... -> /caminho" e "Backup das fotos ... -> /caminho".
func parseBackupPaths(output string) []string {
	var paths []string
	for _, line := range strings.Split(output, "\n") {
		idx := strings.Index(line, "-> ")
		if idx < 0 {
			continue
		}
		if p := strings.TrimSpace(line[idx+len("-> "):]); p != "" {
			paths = append(paths, p)
		}
	}
	return paths
}

func filterPaths(paths []string, target string) []string {
	out := []string{}
	for _, p := range paths {
		switch target {
		case "db":
			if strings.HasSuffix(p, ".dump") {
				out = append(out, p)
			}
		case "files":
			if strings.HasSuffix(p, "-uploads.tar.gz") {
				out = append(out, p)
			}
		default:
			out = append(out, p)
		}
	}
	return out
}

func combine(stdout, stderr string) string {
	combined := strings.TrimSpace(stdout)
	if s := strings.TrimSpace(stderr); s != "" {
		if combined != "" {
			combined += "\n"
		}
		combined += s
	}
	return combined
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…(truncado)"
}
