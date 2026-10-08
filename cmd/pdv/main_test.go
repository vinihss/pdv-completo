package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var testBinary string

func TestMain(m *testing.M) {
	tempDir, err := os.MkdirTemp("", "pdv-test-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(tempDir)

	testBinary = filepath.Join(tempDir, "pdv")
	buildCmd := exec.Command("go", "build", "-o", testBinary, ".")
	if out, err := buildCmd.CombinedOutput(); err != nil {
		panic(string(out))
	}

	os.Exit(m.Run())
}

func runPdv(args ...string) (string, string, int) {
	var stdout, stderr bytes.Buffer
	cmd := exec.Command(testBinary, args...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Env = append(os.Environ(), "TERM=dumb") // Avoid ansi escapes in assertions if needed

	err := cmd.Run()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}
	return stdout.String(), stderr.String(), exitCode
}

func TestUsageNoArgs(t *testing.T) {
	stdout, stderr, code := runPdv()
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}
	if !strings.Contains(stdout, "Uso: ./pdv <domínio> <comando> [args...]") {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
	if stderr != "" {
		t.Fatalf("expected empty stderr, got %s", stderr)
	}
}

func TestUsageHelpFlag(t *testing.T) {
	for _, flag := range []string{"-h", "--help"} {
		stdout, stderr, code := runPdv(flag)
		if code != 0 {
			t.Fatalf("flag %s: expected code 0, got %d", flag, code)
		}
		if !strings.Contains(stdout, "Uso: ./pdv <domínio> <comando> [args...]") {
			t.Fatalf("unexpected stdout for %s: %s", flag, stdout)
		}
		if stderr != "" {
			t.Fatalf("expected empty stderr for %s, got %s", flag, stderr)
		}
	}
}

func TestUnknownCommand(t *testing.T) {
	stdout, stderr, code := runPdv("invalid-command")
	if code != 1 {
		t.Fatalf("expected code 1, got %d", code)
	}
	if !strings.Contains(stderr, "comando desconhecido: invalid-command") {
		t.Fatalf("unexpected stderr: %s (stdout: %s)", stderr, stdout)
	}
}

func TestDevInvalidTarget(t *testing.T) {
	_, stderr, code := runPdv("dev", "invalid")
	if code != 1 {
		t.Fatalf("expected code 1, got %d", code)
	}
	if !strings.Contains(stderr, "uso: ./pdv dev <backend|frontend|all>") {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestDevInvalidProfile(t *testing.T) {
	_, stderr, code := runPdv("dev", "frontend", "--profile", "invalid")
	if code != 1 {
		t.Fatalf("expected code 1, got %d", code)
	}
	if !strings.Contains(stderr, "perfil inválido: invalid") {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestDevBackendWithProfileError(t *testing.T) {
	_, stderr, code := runPdv("dev", "backend", "--profile", "pdv")
	if code != 1 {
		t.Fatalf("expected code 1, got %d", code)
	}
	if !strings.Contains(stderr, "--profile não se aplica a './pdv dev backend'") {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestBuildInvalidSubcommand(t *testing.T) {
	_, stderr, code := runPdv("build", "unknown")
	if code != 1 {
		t.Fatalf("expected code 1, got %d", code)
	}
	if !strings.Contains(stderr, "uso: ./pdv build <standalone|app|backend|frontend> [opções]") {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestTestInvalidSubcommand(t *testing.T) {
	_, stderr, code := runPdv("test", "unknown")
	if code != 1 {
		t.Fatalf("expected code 1, got %d", code)
	}
	if !strings.Contains(stderr, "uso: ./pdv test <backend|frontend|printer|gateway|all>") {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestDbInvalidSubcommand(t *testing.T) {
	_, stderr, code := runPdv("db", "unknown")
	if code != 1 {
		t.Fatalf("expected code 1, got %d", code)
	}
	if !strings.Contains(stderr, "uso: ./pdv db <migrate|migrate-registry|generate|seed|seed-prod|deactivate-demo|provision>") {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestDbProvisionMissingArgs(t *testing.T) {
	_, stderr, code := runPdv("db", "provision")
	if code != 1 {
		t.Fatalf("expected code 1, got %d", code)
	}
	if !strings.Contains(stderr, "uso: ./pdv db provision <slug> [display-name]") {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestStatusOutput(t *testing.T) {
	stdout, _, code := runPdv("status")
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}
	if !strings.Contains(stdout, "── git ──") {
		t.Fatalf("missing git header: %s", stdout)
	}
	if !strings.Contains(stdout, "── worktrees ──") {
		t.Fatalf("missing worktrees header: %s", stdout)
	}
	if !strings.Contains(stdout, "── versões ──") {
		t.Fatalf("missing versões header: %s", stdout)
	}
	if !strings.Contains(stdout, "── dependências locais ──") {
		t.Fatalf("missing dependências locais header: %s", stdout)
	}
}
