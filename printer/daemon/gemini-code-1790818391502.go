package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"

	"gopkg.in/natefinch/lumberjack.v2"
)

// SetupLogger configura o slog com saída em JSON e rotação automática de ficheiros
func SetupLogger(logDirPath string) *slog.Logger {
	// 1. Garante que o diretório de logs existe
	if err := os.MkdirAll(logDirPath, 0755); err != nil {
		slog.Error("Falha ao criar diretório de logs", "error", err)
	}

	logFilePath := filepath.Join(logDirPath, "daemon.log")

	// 2. Configuração do Rotação de Ficheiros (Lumberjack)
	fileRotator := &lumberjack.Logger{
		Filename:   logFilePath,
		MaxSize:    10,   // Tamanho máximo em Megabytes antes de rodar
		MaxBackups: 5,    // Número máximo de ficheiros de backup
		MaxAge:     30,   // Dias máximos de retenção
		Compress:   true, // Compactar ficheiros antigos em .gz
	}

	// 3. MultiWriter: Escreve simultaneamente no Console (stdout) e no Ficheiro de Log
	multiWriter := io.MultiWriter(os.Stdout, fileRotator)

	// 4. Handler JSON estruturado
	handler := slog.NewJSONHandler(multiWriter, &slog.HandlerOptions{
		Level: slog.LevelInfo, // Nível mínimo de log (DEBUG, INFO, WARN, ERROR)
	})

	logger := slog.New(handler)
	slog.SetDefault(logger) // Define como logger padrão global

	return logger
}