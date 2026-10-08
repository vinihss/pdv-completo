package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var buildCmd = &cobra.Command{
	Use:                "build <standalone|app|backend|frontend> [opções]",
	Short:              "standalone/app = Tauri; backend = tsc; frontend = vite",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandleBuild(args)
		os.Exit(code)
	},
}

// HandleBuild processa as opções de build de acordo com o target.
func HandleBuild(args []string) int {
	if len(args) == 0 {
		ui.Die("uso: ./pdv build <standalone|app|backend|frontend> [opções]")
	}
	sub := args[0]
	subArgs := args[1:]
	switch sub {
	case "standalone":
		return runner.ExecScript("scripts/build/build-standalone.sh", subArgs)
	case "app":
		return runner.ExecScript("scripts/build/build-app.sh", subArgs)
	case "backend":
		if len(subArgs) != 0 {
			ui.Die("uso: ./pdv build backend")
		}
		return runner.NpmRun("backend", "build")
	case "frontend":
		if len(subArgs) != 0 {
			ui.Die("uso: ./pdv build frontend")
		}
		return runner.NpmRun("frontend", "build")
	default:
		ui.Die("uso: ./pdv build <standalone|app|backend|frontend> [opções]")
	}
	return 0
}
