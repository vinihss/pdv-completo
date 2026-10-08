package commands

import (
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var deployCmd = &cobra.Command{
	Use:                "deploy <switch|backup|backup-fetch|probe|install|reset|caddy|run-cloud|pedido> [opções]",
	Short:              "Deploy em nuvem (os args vão crus ao script)",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandleDeploy(args)
		os.Exit(code)
	},
}

// HandleDeploy despacha a execução dos scripts de deploy em nuvem.
func HandleDeploy(args []string) int {
	if len(args) == 0 {
		ui.Die("uso: ./pdv deploy <switch|backup|backup-fetch|probe|install|reset|caddy|run-cloud|pedido> [opções]")
	}
	sub := args[0]
	subArgs := args[1:]
	switch sub {
	case "switch":
		return runner.ExecScript("deploy/switch.sh", subArgs)
	case "backup":
		return runner.ExecScript("deploy/backup.sh", subArgs)
	case "backup-fetch":
		return runner.ExecScript("deploy/backup-fetch.sh", subArgs)
	case "probe":
		return runner.ExecScript("deploy/probe-availability.sh", subArgs)
	case "install":
		return runner.ExecScript("deploy/install.sh", subArgs)
	case "reset":
		return runner.ExecScript("deploy/reset.sh", subArgs)
	case "caddy":
		return runner.ExecScript("deploy/caddy-assemble.sh", subArgs)
	case "run-cloud":
		return runner.ExecScript("deploy/run-cloud.sh", subArgs)
	case "pedido":
		return runner.ExecScript("deploy/deploy-pedido-public.sh", subArgs)
	default:
		ui.Die("uso: ./pdv deploy <switch|backup|backup-fetch|probe|install|reset|caddy|run-cloud|pedido> [opções]")
	}
	return 0
}
