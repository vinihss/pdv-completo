package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
)

var setupCmd = &cobra.Command{
	Use:                "setup",
	Short:              "Setup do ambiente de dev",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := runner.ExecScript("scripts/dev/setup-dev.sh", args)
		os.Exit(code)
	},
}
