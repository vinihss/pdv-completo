package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var checkCmd = &cobra.Command{
	Use:                "check [backend|frontend|all]",
	Short:              "critérios de verificação gerais do AGENTS.md (pré-PR); default: all",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandleCheck(args)
		os.Exit(code)
	},
}

// CheckBackend executa build (tsc) e testes (vitest) do backend.
func CheckBackend() int {
	ui.LogMsg("check backend: build (tsc)")
	if code := runner.NpmRun("backend", "build"); code != 0 {
		return code
	}
	ui.LogMsg("check backend: test (vitest)")
	return runner.NpmRun("backend", "test")
}

// CheckFrontend executa lint (oxlint), build (vite) e testes (vitest) do frontend.
func CheckFrontend() int {
	ui.LogMsg("check frontend: lint (oxlint)")
	if code := runner.NpmRun("frontend", "lint"); code != 0 {
		return code
	}
	ui.LogMsg("check frontend: build (vite)")
	if code := runner.NpmRun("frontend", "build"); code != 0 {
		return code
	}
	ui.LogMsg("check frontend: test (vitest)")
	return runner.NpmRun("frontend", "test")
}

// HandleCheck executa as checagens gerais solicitadas.
func HandleCheck(args []string) int {
	target := "all"
	if len(args) > 1 {
		ui.Die("uso: ./pdv check [backend|frontend|all]")
	}
	if len(args) == 1 {
		target = args[0]
	}
	switch target {
	case "backend":
		return CheckBackend()
	case "frontend":
		return CheckFrontend()
	case "all":
		if code := CheckBackend(); code != 0 {
			return code
		}
		if code := CheckFrontend(); code != 0 {
			return code
		}
		return 0
	default:
		ui.Die("uso: ./pdv check [backend|frontend|all]")
	}
	return 0
}
