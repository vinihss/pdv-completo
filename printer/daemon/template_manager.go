package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

type TemplateManager struct {
	storageDir string
	mu         sync.RWMutex
	cache      map[string][]byte
}

func NewTemplateManager(storageDir string) (*TemplateManager, error) {
	if err := os.MkdirAll(storageDir, 0755); err != nil {
		return nil, fmt.Errorf("erro ao criar pasta de templates: %w", err)
	}

	tm := &TemplateManager{
		storageDir: storageDir,
		cache:      make(map[string][]byte),
	}

	if err := tm.loadAllFromDisk(); err != nil {
		slog.Warn("Erro ao carregar templates do disco na inicialização", "error", err)
	}

	return tm, nil
}

func (tm *TemplateManager) SaveTemplate(name string, rawJSON []byte) error {
	var js json.RawMessage
	if err := json.Unmarshal(rawJSON, &js); err != nil {
		return fmt.Errorf("template inválido (JSON malformado): %w", err)
	}

	fileName := fmt.Sprintf("%s.json", name)
	filePath := filepath.Join(tm.storageDir, fileName)

	tm.mu.Lock()
	defer tm.mu.Unlock()

	if err := os.WriteFile(filePath, rawJSON, 0644); err != nil {
		return fmt.Errorf("erro ao gravar template no disco: %w", err)
	}

	tm.cache[name] = rawJSON
	slog.Info("Template sincronizado e salvo localmente", "name", name, "path", filePath)

	return nil
}

func (tm *TemplateManager) GetTemplate(name string) ([]byte, error) {
	tm.mu.RLock()
	content, exists := tm.cache[name]
	tm.mu.RUnlock()

	if exists {
		return content, nil
	}

	filePath := filepath.Join(tm.storageDir, fmt.Sprintf("%s.json", name))
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("template '%s' não encontrado: %w", name, err)
	}

	tm.mu.Lock()
	tm.cache[name] = data
	tm.mu.Unlock()

	return data, nil
}

func (tm *TemplateManager) loadAllFromDisk() error {
	files, err := os.ReadDir(tm.storageDir)
	if err != nil {
		return err
	}

	tm.mu.Lock()
	defer tm.mu.Unlock()

	for _, file := range files {
		if !file.IsDir() && filepath.Ext(file.Name()) == ".json" {
			name := file.Name()[:len(file.Name())-5]
			data, err := os.ReadFile(filepath.Join(tm.storageDir, file.Name()))
			if err == nil {
				tm.cache[name] = data
			}
		}
	}
	slog.Info("Templates carregados do disco", "total", len(tm.cache))
	return nil
}