package cache_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/example/license-platform/sdk/licensego/cache"
)

func TestFileStore_SaveAndLoad_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := cache.FileStore{Path: filepath.Join(dir, "license-cache.json")}

	entry := cache.Entry{KeyID: "test-key", Payload: []byte("payload"), Signature: []byte("sig")}
	if err := store.Save(entry); err != nil {
		t.Fatalf("save não deveria falhar: %v", err)
	}

	got, err := store.Load()
	if err != nil {
		t.Fatalf("load não deveria falhar: %v", err)
	}
	if got.KeyID != entry.KeyID || string(got.Payload) != string(entry.Payload) {
		t.Fatalf("entrada recuperada difere da salva: %+v vs %+v", got, entry)
	}
}

func TestFileStore_Load_EmptyCache(t *testing.T) {
	dir := t.TempDir()
	store := cache.FileStore{Path: filepath.Join(dir, "does-not-exist.json")}

	_, err := store.Load()
	if err != cache.ErrCacheEmpty {
		t.Fatalf("esperava ErrCacheEmpty, obteve %v", err)
	}
}

func TestFileStore_Save_CreatesParentDirectory(t *testing.T) {
	dir := t.TempDir()
	nestedPath := filepath.Join(dir, "nested", "dir", "cache.json")
	store := cache.FileStore{Path: nestedPath}

	if err := store.Save(cache.Entry{KeyID: "k"}); err != nil {
		t.Fatalf("save não deveria falhar ao criar diretórios: %v", err)
	}
	if _, err := os.Stat(nestedPath); err != nil {
		t.Fatalf("arquivo de cache deveria existir: %v", err)
	}
}

func TestFileStore_Save_LeavesNoTempFilesBehind(t *testing.T) {
	dir := t.TempDir()
	store := cache.FileStore{Path: filepath.Join(dir, "cache.json")}

	if err := store.Save(cache.Entry{KeyID: "k"}); err != nil {
		t.Fatalf("save não deveria falhar: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("lendo diretório: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("esperava exatamente 1 arquivo no diretório (sem sobras de .tmp), encontrou %d", len(entries))
	}
}

func TestFileStore_Save_OverwritesPreviousEntry(t *testing.T) {
	dir := t.TempDir()
	store := cache.FileStore{Path: filepath.Join(dir, "cache.json")}

	_ = store.Save(cache.Entry{KeyID: "old"})
	_ = store.Save(cache.Entry{KeyID: "new"})

	got, err := store.Load()
	if err != nil {
		t.Fatalf("load não deveria falhar: %v", err)
	}
	if got.KeyID != "new" {
		t.Fatalf("esperava sobrescrita para 'new', obteve %q", got.KeyID)
	}
}
