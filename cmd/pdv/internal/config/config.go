package config

import (
	"os"
	"path/filepath"
)

// RootPath guarda o caminho absoluto da raiz do repositório.
var RootPath string

func init() {
	RootPath = FindRepoRoot()
}

// FindRepoRoot encontra o diretório raiz do repositório procurando por
// variáveis de ambiente (PDV_ROOT), localização do executável ou
// subindo na hierarquia a partir do diretório atual de trabalho.
func FindRepoRoot() string {
	if envRoot := os.Getenv("PDV_ROOT"); envRoot != "" {
		return envRoot
	}

	// Tenta a partir da localização do executável
	if exePath, err := os.Executable(); err == nil {
		if resolvedPath, err := filepath.EvalSymlinks(exePath); err == nil {
			dir := filepath.Dir(resolvedPath)
			if IsRoot(dir) {
				return dir
			}
			// Pode ser que o executável esteja em cmd/pdv
			parent := filepath.Dir(filepath.Dir(dir))
			if IsRoot(parent) {
				return parent
			}
		}
	}

	// Tenta subindo a partir do CWD
	if cwd, err := os.Getwd(); err == nil {
		curr := cwd
		for {
			if IsRoot(curr) {
				return curr
			}
			parent := filepath.Dir(curr)
			if parent == curr || parent == "." || parent == "/" {
				break
			}
			curr = parent
		}
		return cwd
	}

	return "."
}

// IsRoot verifica se um diretório possui as pastas características da raiz do PDV.
func IsRoot(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "backend")); err == nil {
		if _, err := os.Stat(filepath.Join(dir, "frontend")); err == nil {
			return true
		}
	}
	return false
}
