package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func withTempHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
}

func TestAddServerRoundTrip(t *testing.T) {
	withTempHome(t)

	want := ServerConfig{Name: "prod", URL: "https://admin.example.com", Token: "secret-token"}
	if err := AddServer(want); err != nil {
		t.Fatalf("AddServer: %v", err)
	}

	cfg, err := LoadServersConfig()
	if err != nil {
		t.Fatalf("LoadServersConfig: %v", err)
	}
	if len(cfg.Servers) != 1 {
		t.Fatalf("len(Servers) = %d, want 1", len(cfg.Servers))
	}
	got := cfg.Servers[0]
	if got.Name != want.Name || got.URL != want.URL || got.Token != want.Token {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

func TestSaveServersConfigPermissions(t *testing.T) {
	withTempHome(t)

	if err := AddServer(ServerConfig{Name: "prod", URL: "http://localhost:9090", Token: "t"}); err != nil {
		t.Fatalf("AddServer: %v", err)
	}

	path, err := GetServersConfigPath()
	if err != nil {
		t.Fatalf("GetServersConfigPath: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("file perm = %o, want 0600", perm)
	}

	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("Stat dir: %v", err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0700 {
		t.Fatalf("dir perm = %o, want 0700", perm)
	}
}

func TestSaveServersConfigTightensExistingFile(t *testing.T) {
	withTempHome(t)

	if err := AddServer(ServerConfig{Name: "prod"}); err != nil {
		t.Fatalf("AddServer: %v", err)
	}
	path, _ := GetServersConfigPath()
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatalf("Chmod: %v", err)
	}

	cfg, err := LoadServersConfig()
	if err != nil {
		t.Fatalf("LoadServersConfig: %v", err)
	}
	if err := SaveServersConfig(cfg); err != nil {
		t.Fatalf("SaveServersConfig: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("file perm = %o, want 0600", perm)
	}
}

func TestSetServerSSH(t *testing.T) {
	withTempHome(t)

	if err := AddServer(ServerConfig{Name: "prod", URL: "http://prod", Token: "a"}); err != nil {
		t.Fatalf("AddServer: %v", err)
	}

	if err := SetServerSSH("prod", "10.0.0.1", 2222, "deploy", "/home/deploy/.ssh/id_ed25519", "/srv/pdv"); err != nil {
		t.Fatalf("SetServerSSH: %v", err)
	}

	got, err := GetServer("prod")
	if err != nil {
		t.Fatalf("GetServer: %v", err)
	}
	if got.Host != "10.0.0.1" || got.Port != 2222 || got.User != "deploy" ||
		got.KeyPath != "/home/deploy/.ssh/id_ed25519" || got.RemotePath != "/srv/pdv" {
		t.Fatalf("campos SSH não aplicados: %+v", got)
	}
	if got.URL != "http://prod" || got.Token != "a" {
		t.Fatalf("campos de conexão alterados: %+v", got)
	}
}

func TestSetServerSSHOnlyUpdatesProvidedFields(t *testing.T) {
	withTempHome(t)

	original := ServerConfig{
		Name: "prod", Host: "10.0.0.1", Port: 2222, User: "deploy",
		KeyPath: "/home/deploy/.ssh/id_ed25519", RemotePath: "/srv/pdv",
	}
	if err := AddServer(original); err != nil {
		t.Fatalf("AddServer: %v", err)
	}

	// Só o host muda; os demais valores vazios/zero são ignorados.
	if err := SetServerSSH("prod", "10.0.0.2", 0, "", "", ""); err != nil {
		t.Fatalf("SetServerSSH: %v", err)
	}

	got, err := GetServer("prod")
	if err != nil {
		t.Fatalf("GetServer: %v", err)
	}
	if got.Host != "10.0.0.2" {
		t.Fatalf("Host = %q, want 10.0.0.2", got.Host)
	}
	if got.Port != 2222 || got.User != "deploy" || got.KeyPath != original.KeyPath || got.RemotePath != original.RemotePath {
		t.Fatalf("campos não passados deveriam ser preservados: %+v", got)
	}
}

func TestSetServerSSHMissingServer(t *testing.T) {
	withTempHome(t)

	if err := SetServerSSH("ausente", "10.0.0.1", 22, "u", "", ""); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("SetServerSSH(ausente) err = %v, want os.ErrNotExist", err)
	}
}

func TestGetServer(t *testing.T) {
	withTempHome(t)

	if err := AddServer(ServerConfig{Name: "prod", URL: "http://prod", Token: "a"}); err != nil {
		t.Fatalf("AddServer: %v", err)
	}

	got, err := GetServer("prod")
	if err != nil {
		t.Fatalf("GetServer: %v", err)
	}
	if got.URL != "http://prod" || got.Token != "a" {
		t.Fatalf("unexpected server: %+v", got)
	}

	if _, err := GetServer("missing"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("GetServer(missing) err = %v, want os.ErrNotExist", err)
	}
}

func TestRemoveServer(t *testing.T) {
	withTempHome(t)

	if err := AddServer(ServerConfig{Name: "a"}); err != nil {
		t.Fatalf("AddServer a: %v", err)
	}
	if err := AddServer(ServerConfig{Name: "b"}); err != nil {
		t.Fatalf("AddServer b: %v", err)
	}

	if err := RemoveServer("a"); err != nil {
		t.Fatalf("RemoveServer: %v", err)
	}

	cfg, err := LoadServersConfig()
	if err != nil {
		t.Fatalf("LoadServersConfig: %v", err)
	}
	if len(cfg.Servers) != 1 || cfg.Servers[0].Name != "b" {
		t.Fatalf("unexpected servers after remove: %+v", cfg.Servers)
	}
	if _, err := GetServer("a"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("GetServer(a) err = %v, want os.ErrNotExist", err)
	}
}

func TestUpsertServerPreservesFields(t *testing.T) {
	withTempHome(t)

	original := ServerConfig{
		Name:       "prod",
		Host:       "10.0.0.1",
		Port:       22,
		User:       "deploy",
		KeyPath:    "/home/deploy/.ssh/id_ed25519",
		RemotePath: "/srv/pdv",
	}
	if err := AddServer(original); err != nil {
		t.Fatalf("AddServer: %v", err)
	}

	if err := UpsertServer("prod", "https://admin.example.com", "tok"); err != nil {
		t.Fatalf("UpsertServer: %v", err)
	}

	got, err := GetServer("prod")
	if err != nil {
		t.Fatalf("GetServer: %v", err)
	}
	if got.URL != "https://admin.example.com" || got.Token != "tok" {
		t.Fatalf("URL/Token not updated: %+v", got)
	}
	if got.Host != original.Host || got.Port != original.Port || got.User != original.User ||
		got.KeyPath != original.KeyPath || got.RemotePath != original.RemotePath {
		t.Fatalf("existing fields not preserved: %+v", got)
	}
}

func TestUpsertServerAppendsNew(t *testing.T) {
	withTempHome(t)

	if err := UpsertServer("novo", "http://novo:9090", "tok"); err != nil {
		t.Fatalf("UpsertServer: %v", err)
	}

	cfg, err := LoadServersConfig()
	if err != nil {
		t.Fatalf("LoadServersConfig: %v", err)
	}
	if len(cfg.Servers) != 1 || cfg.Servers[0].Name != "novo" || cfg.Servers[0].URL != "http://novo:9090" {
		t.Fatalf("unexpected servers: %+v", cfg.Servers)
	}
}
