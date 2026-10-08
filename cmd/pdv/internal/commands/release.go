package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var releaseCmd = &cobra.Command{
	Use:                "release <bump> <versão>",
	Short:              "Bump de versão da família standalone",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandleRelease(args)
		os.Exit(code)
	},
}

// HandleRelease processa subcomandos de release.
func HandleRelease(args []string) int {
	if len(args) == 0 {
		ui.Die("uso: ./pdv release <bump> <versão>")
	}
	sub := args[0]
	subArgs := args[1:]
	switch sub {
	case "bump":
		return runner.ExecScript("scripts/release/bump-version.sh", subArgs)
	default:
		ui.Die("uso: ./pdv release <bump> <versão>")
	}
	return 0
}
