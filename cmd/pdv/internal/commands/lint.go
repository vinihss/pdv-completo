package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var lintCmd = &cobra.Command{
	Use:                "lint <frontend|all>",
	Short:              "oxlint; `all` soma o gate de gofmt do ws-gateway (mesmo contrato do CI)",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandleLint(args)
		os.Exit(code)
	},
}

// HandleLint despacha a execução do linter conforme o target.
func HandleLint(args []string) int {
	if len(args) == 0 {
		ui.Die("uso: ./pdv lint <frontend|all>")
	}
	sub := args[0]
	subArgs := args[1:]
	if len(subArgs) != 0 {
		ui.Die("uso: ./pdv lint %s", sub)
	}
	switch sub {
	case "frontend":
		return runner.NpmRun("frontend", "lint")
	case "all":
		ui.LogMsg("── lint frontend (oxlint) ──")
		if code := runner.NpmRun("frontend", "lint"); code != 0 {
			return code
		}
		ui.LogMsg("── lint ws-gateway (gofmt) ──")
		runner.GofmtGate("ws-gateway")
		return 0
	default:
		ui.Die("uso: ./pdv lint <frontend|all>")
	}
	return 0
}
