package commands

import (
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/spf13/cobra"

	"pdv-cli/internal/config"
	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var devCmd = &cobra.Command{
	Use:                "dev <backend|frontend|all> [--profile <pdv|kds|garcon|entregador>]",
	Short:              "npm run dev no diretório (frontend aceita --profile <pdv|kds|garcon|entregador>)",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandleDev(args)
		os.Exit(code)
	},
}

// DevFrontend inicia o frontend com o perfil especificado ou default.
func DevFrontend(profile string) int {
	if profile != "" {
		return runner.NpmRun("frontend", "dev:"+profile)
	}
	return runner.NpmRun("frontend", "dev")
}

// HandleDev processa o comando dev e seus argumentos.
func HandleDev(args []string) int {
	if len(args) == 0 {
		ui.Die("uso: ./pdv dev <backend|frontend|all> [--profile <pdv|kds|garcon|entregador>]")
	}

	target := args[0]
	if target != "backend" && target != "frontend" && target != "all" {
		ui.Die("uso: ./pdv dev <backend|frontend|all> [--profile <pdv|kds|garcon|entregador>]")
	}

	profile := ""
	idx := 1
	for idx < len(args) {
		arg := args[idx]
		if arg == "--profile" {
			if idx+1 >= len(args) {
				ui.Die("uso: ./pdv dev <backend|frontend|all> [--profile <pdv|kds|garcon|entregador>]")
			}
			profile = args[idx+1]
			idx += 2
		} else {
			ui.Die("argumento desconhecido em './pdv dev': %s (uso: ./pdv dev <backend|frontend|all> [--profile <pdv|kds|garcon|entregador>])", arg)
		}
	}

	if profile != "" {
		switch profile {
		case "pdv", "kds", "garcon", "entregador":
		default:
			ui.Die("perfil inválido: %s (esperado: pdv|kds|garcon|entregador)", profile)
		}
		if target == "backend" {
			ui.Die("--profile não se aplica a './pdv dev backend'")
		}
	}

	switch target {
	case "backend":
		return runner.NpmRun("backend", "dev")
	case "frontend":
		return DevFrontend(profile)
	case "all":
		backendCmd := exec.Command("npm", "run", "dev")
		backendCmd.Dir = filepath.Join(config.RootPath, "backend")
		backendCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		backendCmd.Stdout = os.Stdout
		backendCmd.Stderr = os.Stderr

		if err := backendCmd.Start(); err != nil {
			ui.Die("falha ao iniciar backend em background: %v", err)
		}

		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)

		done := make(chan int, 1)
		go func() {
			code := DevFrontend(profile)
			done <- code
		}()

		cleanup := func() {
			if backendCmd.Process != nil {
				_ = syscall.Kill(-backendCmd.Process.Pid, syscall.SIGKILL)
				_ = backendCmd.Process.Kill()
				_ = backendCmd.Wait()
			}
		}

		select {
		case sig := <-sigChan:
			cleanup()
			if sig == os.Interrupt {
				os.Exit(130)
			}
			os.Exit(1)
			return 1
		case code := <-done:
			cleanup()
			return code
		}
	}

	return 0
}
