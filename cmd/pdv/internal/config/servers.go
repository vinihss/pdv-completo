// Package config fornece funções de configuração para o CLI.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ServerConfig representa a configuração de um servidor remoto
type ServerConfig struct {
	Name       string `json:"name"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	User       string `json:"user"`
	KeyPath    string `json:"key_path"`
	RemotePath string `json:"remote_path"`
	LastStatus string `json:"last_status,omitempty"`
}

// ServersConfig representa todas as configurações de servidores
type ServersConfig struct {
	Servers []ServerConfig `json:"servers"`
}

// GetConfigDir retorna o diretório de configuração (~/.pdv)
func GetConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pdv"), nil
}

// GetServersConfigPath retorna o caminho do arquivo de configuração de servidores
func GetServersConfigPath() (string, error) {
	configDir, err := GetConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "servers.json"), nil
}

// LoadServersConfig carrega a configuração de servidores
func LoadServersConfig() (*ServersConfig, error) {
	configPath, err := GetServersConfigPath()
	if err != nil {
		return nil, err
	}

	// Se o arquivo não existe, retorna config vazia
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return &ServersConfig{Servers: []ServerConfig{}}, nil
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}

	var config ServersConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

// SaveServersConfig salva a configuração de servidores
func SaveServersConfig(config *ServersConfig) error {
	configPath, err := GetServersConfigPath()
	if err != nil {
		return err
	}

	// Cria o diretório se não existir
	configDir := filepath.Dir(configPath)
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, data, 0644)
}

// AddServer adiciona um novo servidor à configuração
func AddServer(server ServerConfig) error {
	config, err := LoadServersConfig()
	if err != nil {
		return err
	}

	// Verifica se já existe servidor com mesmo nome
	for _, s := range config.Servers {
		if s.Name == server.Name {
			return os.ErrExist
		}
	}

	config.Servers = append(config.Servers, server)
	return SaveServersConfig(config)
}

// RemoveServer remove um servidor da configuração
func RemoveServer(name string) error {
	config, err := LoadServersConfig()
	if err != nil {
		return err
	}

	newServers := []ServerConfig{}
	for _, s := range config.Servers {
		if s.Name != name {
			newServers = append(newServers, s)
		}
	}

	config.Servers = newServers
	return SaveServersConfig(config)
}

// UpdateServer atualiza um servidor existente
func UpdateServer(server ServerConfig) error {
	config, err := LoadServersConfig()
	if err != nil {
		return err
	}

	for i, s := range config.Servers {
		if s.Name == server.Name {
			config.Servers[i] = server
			return SaveServersConfig(config)
		}
	}

	return os.ErrNotExist
}

// GetServer retorna um servidor pelo nome
func GetServer(name string) (*ServerConfig, error) {
	config, err := LoadServersConfig()
	if err != nil {
		return nil, err
	}

	for _, s := range config.Servers {
		if s.Name == name {
			return &s, nil
		}
	}

	return nil, os.ErrNotExist
}
