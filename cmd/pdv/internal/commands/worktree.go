package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
)

var worktreeCmd = &cobra.Command{
	Use:                "worktree <new|list|rm> [args...]",
	Short:              "Convenção de worktree por branch",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := runner.ExecScript("scripts/dev/dev-worktree.sh", args)
		os.Exit(code)
	},
}
