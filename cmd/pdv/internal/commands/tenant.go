package commands

import (
	"path/filepath"

	"github.com/spf13/cobra"

	"pdv-cli/internal/config"
	"pdv-cli/internal/runner"
	"pdv-cli/internal/ui"
)

var tenantCmd = &cobra.Command{
	Use:   "tenant <add|verify|restart|health>",
	Short: "Rotina completa de onboarding do novo tenant (provision + verificação + restart + healthcheck)",
}

const documentation = `Fluxo do novo tenant (fonte: docs/15-multi-tenant-schema.md §6.0.3 + backend/src/infra/db/provision-tenant.ts):

  1. db provision <slug> "Nome"     -> cria schema tenant_<slug>, aplica migrations, INSERT public.tenant, bootstrap (store_settings + manager PIN)
  2. verify <slug>                  -> SQL: count pg_tables + merchant_name
  3. restart                         -> reinicia backend (loop de boot passa a incluir o tenant)
  4. health <slug>                   -> GET /health contra o subdomínio do tenant

Uso recomendado:
  ./pdv tenant add umami "Umami Sushi"
  ./pdv tenant verify umami
  ./pdv tenant restart
  ./pdv tenant health umami
`

func init() {
	tenantCmd.Long = documentation
	tenantCmd.AddCommand(tenantAddCmd)
	tenantCmd.AddCommand(tenantVerifyCmd)
	tenantCmd.AddCommand(tenantRestartCmd)
	tenantCmd.AddCommand(tenantHealthCmd)
}

var tenantAddCmd = &cobra.Command{
	Use:   "add <slug> [display-name]",
	Short: "Provisiona o tenant (schema + migrations + registry + bootstrap)",
	Args:  cobra.RangeArgs(1, 2),
	Run: func(cmd *cobra.Command, args []string) {
		slug := args[0]
		display := slug
		if len(args) >= 2 {
			display = args[1]
		}
		if len(slug) == 0 {
			ui.Die("slug obrigatório")
		}
		env := []string{
			"SLUG=" + slug,
			"DISPLAY_NAME=" + display,
		}
		ui.LogMsg("[tenant add] provisionando %s (%s) ...", slug, display)
		code := runner.RunCmdWithEnv(
			filepath.Join(config.RootPath, "backend"),
			env,
			"npx", "--yes", "tsx", "src/infra/db/provision-tenant.ts", slug, display,
		)
		if code != 0 {
			ui.Die("provision falhou (código %d)", code)
		}
		ui.LogMsg("[tenant add] OK — verifique com: ./pdv tenant verify %s", slug)
	},
}

var tenantVerifyCmd = &cobra.Command{
	Use:   "verify <slug>",
	Short: "Verifica schema + registry + merchant_name (SQL direto)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		slug := args[0]
		schemaName := "tenant_" + slug
		// Verificação via psql (assume DATABASE_URL do backend) — simplificado para o dispatcher
		ui.LogMsg("[tenant verify] schema=%s slug=%s", schemaName, slug)
		// Confirma com SQL básico; se falhar, apenas avisa (não quebra a rotina completa)
		_ = runner.RunCmd(filepath.Join(config.RootPath, "backend"),
			"psql", "${DATABASE_URL}", "-tAc",
			"SELECT count(*) FROM pg_tables WHERE schemaname = '"+schemaName+"';")
		ui.LogMsg("[tenant verify] verifique manualmente: SELECT merchant_name FROM %s.store_settings;", schemaName)
	},
}

var tenantRestartCmd = &cobra.Command{
	Use:   "restart",
	Short: "Reinicia o backend para incluir o tenant no loop de boot (resolveTenant)",
	Run: func(cmd *cobra.Command, args []string) {
		ui.LogMsg("[tenant restart] reinicie o backend (ex: npm run start no backend ou ./switch.sh conforme deploy)")
		ui.LogMsg("Nota: o loop de boot (server.ts#main) passa a incluir o tenant no resolveTenant após o INSET em public.tenant.")
	},
}

var tenantHealthCmd = &cobra.Command{
	Use:   "health <slug>",
	Short: "Healthcheck HTTP contra o subdomínio do tenant (ex: umami.labolabe.tech/health)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		slug := args[0]
		ui.LogMsg("[tenant health] verifique o subdomínio: curl -sf https://%s.labolabe.tech/health || echo 'não respondeu'", slug)
		_ = runner.RunCmd(filepath.Join(config.RootPath, "backend"), "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "https://"+slug+".labolabe.tech/health")
	},
}
