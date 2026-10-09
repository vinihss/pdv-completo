package commands

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	"pdv-cli/internal/tui"
)

var tuiCmd = &cobra.Command{
	Use:   "tui",
	Short: "Interface interativa (TUI) para gerenciamento de tenants",
	Long: `Interface Terminal User Interface (TUI) usando Bubble Tea para gerenciar
tenants de forma interativa. Fornece menus navegáveis, formulários e
feedback visual em tempo real para todas as operações de tenant.

Operações disponíveis:
  - Listar tenants com status
  - Adicionar novo tenant (provisionar)
  - Reset PIN do manager
  - Suspender/reativar tenant
  - Backup/dump do tenant
  - Remover tenant
  - Verificar status dos serviços
  - Adicionar usuário
  - Editar configurações da loja

Uso:
  ./pdv tui           # inicia a interface interativa
  ./pdv tui --help    # mostra esta ajuda

Navegação:
  ↑/↓ ou j/k    navegar em menus e listas
  enter         selecionar/confirmar
  esc ou q      voltar/sair
  tab           próximo campo no formulário
  shift+tab     campo anterior no formulário

Atalhos na tela de detalhes do tenant:
  r             reset PIN do manager
  s             editar configurações da loja
  u             adicionar usuário
  d             backup/dump do tenant`,
	Run: func(cmd *cobra.Command, args []string) {
		runTUI()
	},
}

func runTUI() {
	model := tui.NewModel()
	p := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Erro ao executar TUI: %v\n", err)
		os.Exit(1)
	}
}
