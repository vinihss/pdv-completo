// Package cache implementa o armazenamento local do SDK: o último
// documento de licença assinado recebido do servidor, para permitir
// operação offline dentro da janela de tolerância configurada.
package cache

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Entry é o que fica persistido em disco: o documento assinado bruto
// (payload + assinatura + key_id), exatamente como recebido do
// servidor. A verificação da assinatura acontece na leitura, nunca
// na escrita — o cache em si não é uma fonte de confiança.
type Entry struct {
	KeyID     string `json:"key_id"`
	Payload   []byte `json:"payload"`
	Signature []byte `json:"signature"`
}

// Store é a porta de cache que o Client do SDK consome.
type Store interface {
	Load() (Entry, error)
	Save(Entry) error
}

// FileStore implementa Store em um arquivo local, com gravação atômica:
// escreve em um arquivo temporário no mesmo diretório e faz rename para
// o destino final. Isso evita que um crash no meio da escrita deixe o
// cache corrompido — o rename é atômico no mesmo sistema de arquivos.
type FileStore struct {
	Path string
}

// ErrCacheEmpty é retornado por Load quando ainda não há nada em cache
// (ex.: primeira execução da aplicação cliente).
var ErrCacheEmpty = fmt.Errorf("cache local vazio")

func (f FileStore) Load() (Entry, error) {
	data, err := os.ReadFile(f.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return Entry{}, ErrCacheEmpty
		}
		return Entry{}, fmt.Errorf("lendo arquivo de cache: %w", err)
	}
	var entry Entry
	if err := json.Unmarshal(data, &entry); err != nil {
		return Entry{}, fmt.Errorf("decodificando cache: %w", err)
	}
	return entry, nil
}

func (f FileStore) Save(entry Entry) error {
	dir := filepath.Dir(f.Path)
	if dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("criando diretório de cache: %w", err)
		}
	}

	data, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("codificando cache: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".cache-*.tmp")
	if err != nil {
		return fmt.Errorf("criando arquivo temporário de cache: %w", err)
	}
	tmpPath := tmp.Name()
	// Se qualquer etapa abaixo falhar, o arquivo temporário é removido —
	// o arquivo de cache final só é tocado no rename, que é atômico.
	defer os.Remove(tmpPath)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("escrevendo cache temporário: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sincronizando cache temporário: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("fechando cache temporário: %w", err)
	}
	if err := os.Rename(tmpPath, f.Path); err != nil {
		return fmt.Errorf("substituindo cache atomicamente: %w", err)
	}
	return nil
}

var _ Store = FileStore{}
