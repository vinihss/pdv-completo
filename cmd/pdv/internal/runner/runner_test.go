package runner

import (
	"os"
	"path/filepath"
	"testing"

	"pdv-cli/internal/config"
)

func TestRunCmd(t *testing.T) {
	tempDir := t.TempDir()
	code := RunCmd(tempDir, "echo", "hello")
	if code != 0 {
		t.Fatalf("expected code 0, got %d", code)
	}
}

func TestRunCmdWithEnv(t *testing.T) {
	tempDir := t.TempDir()
	code := RunCmdWithEnv(tempDir, []string{"FOO=bar"}, "sh", "-c", "test \"$FOO\" = \"bar\"")
	if code != 0 {
		t.Fatalf("expected code 0 for matching env, got %d", code)
	}
}

func TestGoGateNonExistent(t *testing.T) {
	config.RootPath = t.TempDir()
	code := GoGate("does-not-exist")
	if code != 1 {
		t.Fatalf("expected code 1 for non-existent directory, got %d", code)
	}
}

func TestGofmtGateOk(t *testing.T) {
	tempDir := t.TempDir()
	pkgDir := filepath.Join(tempDir, "mypkg")
	if err := os.Mkdir(pkgDir, 0755); err != nil {
		t.Fatal(err)
	}
	src := "package mypkg\n\nfunc Hello() {}\n"
	if err := os.WriteFile(filepath.Join(pkgDir, "hello.go"), []byte(src), 0644); err != nil {
		t.Fatal(err)
	}

	config.RootPath = tempDir
	GofmtGate("mypkg")
}
