package ssh

import (
	"context"
	"path/filepath"
	"testing"
)

func TestNewDefaultsPort(t *testing.T) {
	c := New("host.example.com", 0, "deploy", "")
	if c.port != 22 {
		t.Fatalf("port = %d, want 22", c.port)
	}
	if c.host != "host.example.com" || c.user != "deploy" {
		t.Fatalf("client inesperado: %+v", c)
	}

	c2 := New("10.0.0.1", 2222, "u", "/some/key")
	if c2.port != 2222 {
		t.Fatalf("port = %d, want 2222", c2.port)
	}
}

func TestRunWithMissingKeyReturnsError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	c := New("10.0.0.1", 22, "deploy", filepath.Join(t.TempDir(), "chave-inexistente"))

	err := c.Run(context.Background(), "echo oi", func(string) {})
	if err == nil {
		t.Fatal("esperado erro por chave SSH ausente")
	}
}

func TestRunWithEmptyHostReturnsError(t *testing.T) {
	c := New("", 22, "deploy", "")
	err := c.Run(context.Background(), "echo oi", func(string) {})
	if err == nil {
		t.Fatal("esperado erro por host vazio")
	}
}
