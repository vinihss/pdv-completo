package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var testCmd = &cobra.Command{
	Use:                "test <backend|frontend|printer|gateway|all>",
	Short:              "suítes: vitest (npm) e go test (daemon e gateway); `all` roda os quatro nessa ordem",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandleTest(args)
		os.Exit(code)
	},
}

// HandleTest despacha a execução dos testes conforme o target escolhido.
func HandleTest(args []string) int {
	if len(args) == 0 {
		ui.Die("uso: ./pdv test <backend|frontend|printer|gateway|all>")
	}
	sub := args[0]
	subArgs := args[1:]
	if len(subArgs) != 0 {
		ui.Die("uso: ./pdv test %s", sub)
	}
	switch sub {
	case "backend":
		return runner.NpmRun("backend", "test")
	case "frontend":
		return runner.NpmRun("frontend", "test")
	case "printer":
		return runner.GoGate("printer/daemon")
	case "gateway":
		return runner.GoGate("ws-gateway")
	case "all":
		ui.LogMsg("── test backend (vitest) ──")
		if code := runner.NpmRun("backend", "test"); code != 0 {
			return code
		}
		ui.LogMsg("── test frontend (vitest) ──")
		if code := runner.NpmRun("frontend", "test"); code != 0 {
			return code
		}
		ui.LogMsg("── test printer (go) ──")
		if code := runner.GoGate("printer/daemon"); code != 0 {
			return code
		}
		ui.LogMsg("── test gateway (go) ──")
		if code := runner.GoGate("ws-gateway"); code != 0 {
			return code
		}
		return 0
	default:
		ui.Die("uso: ./pdv test <backend|frontend|printer|gateway|all>")
	}
	return 0
}
