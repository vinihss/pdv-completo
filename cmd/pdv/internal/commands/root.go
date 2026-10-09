package commands

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"pdv-cli/internal/config"
	"pdv-cli/internal/ui"
)

const usageText = `Uso: ./pdv <domínio> <comando> [args...]

Domínios:
  status                         Diagnóstico do ambiente (read-only: git,
                                 worktrees, versões, dependências locais)
  setup                          Setup do ambiente de dev
  worktree <new|list|rm>         Convenção de worktree por branch
  dev <backend|frontend|all>     npm run dev no diretório (frontend aceita
                                 --profile <pdv|kds|garcon|entregador>)
  build <standalone|app|backend|frontend>
                                 standalone/app = Tauri; backend = tsc;
                                 frontend = vite
  test <backend|frontend|gateway|all>
                                 suítes: vitest (npm) e go test (gateway);
                                 ` + "`all`" + ` roda os três nessa ordem
  lint <frontend|all>            oxlint; ` + "`all`" + ` soma o gate de gofmt do
                                 ws-gateway (mesmo contrato do CI)
  db <migrate|migrate-registry|generate|seed|seed-prod|deactivate-demo|provision>
                                 wrappers dos scripts npm do backend
  tenant <add|verify|restart|health>
                                 Rotina completa de onboarding do novo tenant
                                 (provision + verificação SQL + restart + health)
  check [backend|frontend|all]   critérios de verificação gerais do AGENTS.md
                                 (pré-PR); default: all
  release bump <versão>          Bump de versão da família standalone
  deploy <switch|backup|backup-fetch|probe|install|reset|caddy|run-cloud|pedido> [opções]
                                 Deploy em nuvem (os args vão crus ao script)
  -h|--help                      Esta ajuda

Sem argumentos, ./pdv imprime esta ajuda e sai com 0.
Cada domínio com argumento inválido imprime o uso e sai com != 0.
`

var rootCmd = &cobra.Command{
	Use:                "pdv",
	Short:              "Ponto de entrada único para scripts, npm e go do PDV Restaurante/Pub",
	SilenceErrors:      true,
	SilenceUsage:       true,
	DisableFlagParsing: false,
	Run: func(cmd *cobra.Command, args []string) {
		PrintUsage()
	},
}

// PrintUsage imprime a mensagem canônica de uso do CLI.
func PrintUsage() {
	fmt.Print(usageText)
}

func init() {
	rootCmd.SetHelpFunc(func(cmd *cobra.Command, args []string) {
		PrintUsage()
	})
	rootCmd.SetUsageFunc(func(cmd *cobra.Command) error {
		PrintUsage()
		return nil
	})

	// Adiciona todos os comandos de domínio ao root
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(setupCmd)
	rootCmd.AddCommand(worktreeCmd)
	rootCmd.AddCommand(devCmd)
	rootCmd.AddCommand(buildCmd)
	rootCmd.AddCommand(testCmd)
	rootCmd.AddCommand(lintCmd)
	rootCmd.AddCommand(dbCmd)
	rootCmd.AddCommand(checkCmd)
	rootCmd.AddCommand(releaseCmd)
	rootCmd.AddCommand(deployCmd)
	rootCmd.AddCommand(tenantCmd)
}

// Execute inicializa e despacha a execução da árvore de comandos do CLI.
func Execute() {
	config.RootPath = config.FindRepoRoot()

	if len(os.Args) < 2 {
		PrintUsage()
		os.Exit(0)
	}

	firstArg := os.Args[1]
	if firstArg == "-h" || firstArg == "--help" {
		PrintUsage()
		os.Exit(0)
	}

	// Verifica se é um comando conhecido antes de executar ou deixa o cobra processar
	found := false
	for _, cmd := range rootCmd.Commands() {
		if cmd.Name() == firstArg || (cmd.HasAlias(firstArg)) {
			found = true
			break
		}
	}

	if !found && firstArg != "help" {
		ui.Die("comando desconhecido: %s (rode ./pdv --help)", firstArg)
	}

	if err := rootCmd.Execute(); err != nil {
		ui.Die("%v", err)
	}
}
