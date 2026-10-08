package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var printerCmd = &cobra.Command{
	Use:                "printer <install|package|test-local> [opções]",
	Short:              "Daemon de impressão (Linux)",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandlePrinter(args)
		os.Exit(code)
	},
}

// HandlePrinter despacha a execução dos scripts do daemon de impressão.
func HandlePrinter(args []string) int {
	if len(args) == 0 {
		ui.Die("uso: ./pdv printer <install|package|test-local> [opções]")
	}
	sub := args[0]
	subArgs := args[1:]
	switch sub {
	case "install":
		return runner.ExecScript("printer/scripts/install-linux.sh", subArgs)
	case "package":
		return runner.ExecScript("printer/scripts/package-daemon-linux.sh", subArgs)
	case "test-local":
		return runner.ExecScript("printer/scripts/test-local.sh", subArgs)
	default:
		ui.Die("uso: ./pdv printer <install|package|test-local> [opções]")
	}
	return 0
}
