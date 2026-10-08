package runner

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"pdv-cli/internal/config"
	"pdv-cli/internal/ui"
)

// RunCmd executa um comando arbitrário no diretório especificado, ligando os fluxos padrão de I/O.
func RunCmd(dir string, name string, args ...string) int {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	err := cmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "erro ao executar %s: %v\n", name, err)
		return 1
	}
	return 0
}

// RunCmdWithEnv executa um comando estendendo as variáveis de ambiente atuais.
func RunCmdWithEnv(dir string, env []string, name string, args ...string) int {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), env...)
	err := cmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "erro ao executar %s: %v\n", name, err)
		return 1
	}
	return 0
}

// NpmRun executa `npm run <script> [-- <extraArgs...>]` dentro de um subdiretório do repo.
func NpmRun(relDir string, script string, extraArgs ...string) int {
	args := []string{"run", script}
	if len(extraArgs) > 0 {
		args = append(args, "--")
		args = append(args, extraArgs...)
	}
	return RunCmd(filepath.Join(config.RootPath, relDir), "npm", args...)
}

// GoGate executa o ciclo de validação Go (`go build ./...`, `go vet ./...` e `go test -count=1 ./...`).
func GoGate(relDir string) int {
	dir := filepath.Join(config.RootPath, relDir)
	if _, err := os.Stat(dir); err != nil {
		ui.WarnMsg("diretório não encontrado: %s", relDir)
		return 1
	}
	if code := RunCmd(dir, "go", "build", "./..."); code != 0 {
		return code
	}
	if code := RunCmd(dir, "go", "vet", "./..."); code != 0 {
		return code
	}
	return RunCmd(dir, "go", "test", "-count=1", "./...")
}

// GofmtGate verifica se todos os arquivos Go no subdiretório estão formatados de acordo com o `gofmt`.
func GofmtGate(relDir string) {
	dir := filepath.Join(config.RootPath, relDir)
	if _, err := os.Stat(dir); err != nil {
		ui.Die("diretório não encontrado: %s", relDir)
	}
	cmd := exec.Command("gofmt", "-l", ".")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		ui.Die("falha ao executar gofmt em %s: %v", relDir, err)
	}
	unformatted := strings.TrimSpace(string(out))
	if unformatted != "" {
		fmt.Fprintln(os.Stderr, unformatted)
		ui.Die("arquivos fora de formato em %s — rode: (cd %s && gofmt -w .)", relDir, relDir)
	}
	ui.LogMsg("gofmt ok: %s", relDir)
}

// ExecScript executa um script bash relativo à raiz do repositório com argumentos adicionais.
func ExecScript(scriptRelPath string, args []string) int {
	scriptPath := filepath.Join(config.RootPath, scriptRelPath)
	allArgs := append([]string{scriptPath}, args...)
	return RunCmd(config.RootPath, "bash", allArgs...)
}
