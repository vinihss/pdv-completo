package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/minio/selfupdate"
)

const CurrentVersion = "1.0.0"
const UpdateURL = "https://api.meusistema.com/daemon/latest.json"

type UpdateManifest struct {
	Version         string `json:"version"`
	URLWindowsAMD64 string `json:"url_windows_amd64"`
	URLLinuxAMD64   string `json:"url_linux_amd64"`
	SHA256          string `json:"sha256"`
}

func CheckAndApplyUpdate() error {
	client := http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(UpdateURL)
	if err != nil {
		return fmt.Errorf("falha ao verificar atualizações: %w", err)
	}
	defer resp.Body.Close()

	var manifest UpdateManifest
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return fmt.Errorf("falha ao descodificar manifesto: %w", err)
	}

	if manifest.Version == CurrentVersion {
		slog.Debug("Daemon já está na versão mais recente", "version", CurrentVersion)
		return nil
	}

	slog.Info("Nova versão encontrada. Iniciando download...", "target_version", manifest.Version)

	var downloadURL string
	if runtime.GOOS == "windows" {
		downloadURL = manifest.URLWindowsAMD64
	} else if runtime.GOOS == "linux" {
		downloadURL = manifest.URLLinuxAMD64
	} else {
		return fmt.Errorf("plataforma %s não suportada para update", runtime.GOOS)
	}

	binResp, err := client.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("falha no download: %w", err)
	}
	defer binResp.Body.Close()

	hasher := sha256.New()
	teeReader := io.TeeReader(binResp.Body, hasher)

	err = selfupdate.Apply(teeReader, selfupdate.Options{})
	if err != nil {
		if rerr := selfupdate.RollbackError(err); rerr != nil {
			slog.Error("Erro fatal no rollback do update", "error", rerr)
		}
		return fmt.Errorf("erro ao aplicar atualização: %w", err)
	}

	if hex.EncodeToString(hasher.Sum(nil)) != manifest.SHA256 {
		return fmt.Errorf("checksum SHA256 diverge do esperado")
	}

	slog.Info("Atualização aplicada com sucesso! Reiniciando serviço...")
	return RestartDaemon()
}

func RestartDaemon() error {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("cmd.exe", "/c", "net stop PDVDaemon && net start PDVDaemon")
		return cmd.Start()
	} else if runtime.GOOS == "linux" {
		cmd := exec.Command("systemctl", "restart", "pdv-daemon")
		return cmd.Start()
	}

	executable, err := os.Executable()
	if err != nil {
		return err
	}
	exec.Command(executable, os.Args[1:]...).Start()
	os.Exit(0)
	return nil
}