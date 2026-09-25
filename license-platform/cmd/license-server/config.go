package main

import "os"

// config concentra a leitura de variáveis de ambiente, conforme
// documentado no README do projeto. Nenhuma outra parte do código lê
// os.Getenv diretamente — isso mantém o resto do sistema livre de
// dependência do ambiente de execução real, o que facilita testes.
type config struct {
	HTTPAddr     string
	DatabasePath string
	Issuer       string
	KeyID        string
}

func loadConfig() config {
	return config{
		HTTPAddr:     getEnv("HTTP_ADDR", ":8080"),
		DatabasePath: getEnv("DATABASE_PATH", "./data/license-platform.db"),
		Issuer:       getEnv("LICENSE_ISSUER", "license-server.local"),
		KeyID:        getEnv("LICENSE_KEY_ID", "dev-license-key"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
