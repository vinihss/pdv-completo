package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsRoot(t *testing.T) {
	tempDir := t.TempDir()

	if IsRoot(tempDir) {
		t.Fatalf("expected IsRoot(%s) to be false for empty directory", tempDir)
	}

	if err := os.Mkdir(filepath.Join(tempDir, "backend"), 0755); err != nil {
		t.Fatal(err)
	}
	if IsRoot(tempDir) {
		t.Fatalf("expected IsRoot(%s) to be false with only backend directory", tempDir)
	}

	if err := os.Mkdir(filepath.Join(tempDir, "frontend"), 0755); err != nil {
		t.Fatal(err)
	}
	if !IsRoot(tempDir) {
		t.Fatalf("expected IsRoot(%s) to be true with both backend and frontend directories", tempDir)
	}
}

func TestFindRepoRootEnv(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("PDV_ROOT", tempDir)

	root := FindRepoRoot()
	if root != tempDir {
		t.Fatalf("expected FindRepoRoot() = %s, got %s", tempDir, root)
	}
}
