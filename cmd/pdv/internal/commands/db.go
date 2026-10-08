package commands

import (
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"pdv-cli/internal/config"
	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var dbCmd = &cobra.Command{
	Use:                "db <migrate|migrate-registry|generate|seed|seed-prod|deactivate-demo|provision>",
	Short:              "wrappers dos scripts npm do backend",
	DisableFlagParsing: true,
	Run: func(cmd *cobra.Command, args []string) {
		code := HandleDb(args)
		os.Exit(code)
	},
}

// HandleDb processa as operações de banco de dados.
func HandleDb(args []string) int {
	if len(args) == 0 {
		ui.Die("uso: ./pdv db <migrate|migrate-registry|generate|seed|seed-prod|deactivate-demo|provision>")
	}
	sub := args[0]
	subArgs := args[1:]
	switch sub {
	case "migrate":
		if len(subArgs) != 0 {
			ui.Die("uso: ./pdv db migrate")
		}
		return runner.NpmRun("backend", "db:migrate")
	case "migrate-registry":
		if len(subArgs) != 0 {
			ui.Die("uso: ./pdv db migrate-registry")
		}
		return runner.NpmRun("backend", "db:migrate:registry")
	case "generate":
		if len(subArgs) != 0 {
			ui.Die("uso: ./pdv db generate")
		}
		return runner.NpmRun("backend", "db:generate")
	case "seed":
		if len(subArgs) != 0 {
			ui.Die("uso: ./pdv db seed")
		}
		return runner.NpmRun("backend", "seed")
	case "seed-prod":
		if len(subArgs) != 0 {
			ui.Die("uso: ./pdv db seed-prod")
		}
		return runner.NpmRun("backend", "seed:prod")
	case "deactivate-demo":
		if len(subArgs) != 0 {
			ui.Die("uso: ./pdv db deactivate-demo")
		}
		return runner.NpmRun("backend", "db:deactivate-demo")
	case "provision":
		if len(subArgs) == 0 {
			ui.Die("uso: ./pdv db provision <slug> [display-name]")
		}
		slug := subArgs[0]
		displayName := ""
		if len(subArgs) >= 2 {
			displayName = subArgs[1]
		}
		env := []string{
			"SLUG=" + slug,
			"DISPLAY_NAME=" + displayName,
		}
		return runner.RunCmdWithEnv(
			filepath.Join(config.RootPath, "backend"),
			env,
			"npx", "--yes", "tsx", "src/infra/db/provision-tenant.ts",
		)
	default:
		ui.Die("uso: ./pdv db <migrate|migrate-registry|generate|seed|seed-prod|deactivate-demo|provision>")
	}
	return 0
}
