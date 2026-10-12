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
	URL        string `json:"url,omitempty"`
	Token      string `json:"token,omitempty"`
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

	// Cria o diretório se não existir. O diretório guarda o token, então é
	// privado ao usuário (0700).
	configDir := filepath.Dir(configPath)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return err
	}

	// os.WriteFile não altera o modo de um arquivo já existente — força 0600
	// para que o token nunca fique legível por outros usuários.
	return os.Chmod(configPath, 0600)
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

// UpsertServer salva a URL e o token de um admin-server. Se já existir uma
// entrada com o mesmo nome, atualiza só Name/URL/Token e preserva os demais
// campos (host/port/user/key_path/remote_path); senão acrescenta.
func UpsertServer(name, url, token string) error {
	config, err := LoadServersConfig()
	if err != nil {
		return err
	}

	for i, s := range config.Servers {
		if s.Name == name {
			config.Servers[i].Name = name
			config.Servers[i].URL = url
			config.Servers[i].Token = token
			return SaveServersConfig(config)
		}
	}

	config.Servers = append(config.Servers, ServerConfig{
		Name:  name,
		URL:   url,
		Token: token,
	})
	return SaveServersConfig(config)
}

// SetServerSSH atualiza os campos SSH de um servidor já existente. Só os
// valores não-zero (não-vazios, para strings) são aplicados, preservando o que
// o usuário não passou. Devolve os.ErrNotExist se o servidor não existir.
func SetServerSSH(name, host string, port int, user, keyPath, remotePath string) error {
	config, err := LoadServersConfig()
	if err != nil {
		return err
	}

	for i, s := range config.Servers {
		if s.Name != name {
			continue
		}
		if host != "" {
			config.Servers[i].Host = host
		}
		if port > 0 {
			config.Servers[i].Port = port
		}
		if user != "" {
			config.Servers[i].User = user
		}
		if keyPath != "" {
			config.Servers[i].KeyPath = keyPath
		}
		if remotePath != "" {
			config.Servers[i].RemotePath = remotePath
		}
		return SaveServersConfig(config)
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
