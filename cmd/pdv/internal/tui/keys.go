// keys.go - Keybindings estilo Vim e convenções Charm
package tui

import "github.com/charmbracelet/bubbles/key"

// ============================================================
// KEYBINDINGS ESTILO VIM
// ============================================================
// Segue as convenções de editores Vim e aplicações Charm:
// - j/k para navegação vertical (além de setas)
// - h/l para navegação horizontal/back-forward
// - g/G para início/fim
// - / para busca
// - ? para ajuda
// - Ctrl+letras para ações rápidas

// KeyMap define todos os keybindings da aplicação
type KeyMap struct {
	// Navegação vertical
	Up      key.Binding
	Down    key.Binding
	Top     key.Binding // g - início
	Bottom  key.Binding // G - fim

	// Navegação horizontal (formulários)
	Left    key.Binding
	Right   key.Binding
	Forward key.Binding // Tab/ctrl+f
	Back    key.Binding // Shift+Tab/ctrl+b

	// Ações principais
	Select  key.Binding // Enter
	Cancel  key.Binding // Esc
	Confirm key.Binding // y/s
	Reject  key.Binding // n

	// Ações de tenant
	Add     key.Binding // a
	Edit    key.Binding // e
	Delete  key.Binding // d
	Reset   key.Binding // r
	Save    key.Binding // ctrl+s
	Search  key.Binding // /
	Help    key.Binding // ?
	Refresh key.Binding // ctrl+r / R

	// Ações de formulário
	Next    key.Binding // Tab
	Prev    key.Binding // Shift+Tab
	Submit  key.Binding // Enter
	Clear   key.Binding // ctrl+u

	// Navegação entre telas
	Quit    key.Binding // q / ctrl+c
	BackScreen key.Binding // Esc / h
}

// DefaultKeyMap retorna o mapa de teclas padrão
func DefaultKeyMap() KeyMap {
	return KeyMap{
		// Navegação vertical (Vim-style + setas)
		Up: key.NewBinding(
			key.WithKeys("up", "k"),
			key.WithHelp("↑/k", "cima"),
		),
		Down: key.NewBinding(
			key.WithKeys("down", "j"),
			key.WithHelp("↓/j", "baixo"),
		),
		Top: key.NewBinding(
			key.WithKeys("g"),
			key.WithHelp("g", "início"),
		),
		Bottom: key.NewBinding(
			key.WithKeys("G"),
			key.WithHelp("G", "fim"),
		),

		// Navegação horizontal
		Left: key.NewBinding(
			key.WithKeys("left", "h"),
			key.WithHelp("←/h", "esquerda"),
		),
		Right: key.NewBinding(
			key.WithKeys("right", "l"),
			key.WithHelp("→/l", "direita"),
		),
		Forward: key.NewBinding(
			key.WithKeys("tab", "ctrl+f"),
			key.WithHelp("tab", "próximo"),
		),
		Back: key.NewBinding(
			key.WithKeys("shift+tab", "ctrl+b"),
			key.WithHelp("shift+tab", "anterior"),
		),

		// Ações principais
		Select: key.NewBinding(
			key.WithKeys("enter"),
			key.WithHelp("enter", "selecionar"),
		),
		Cancel: key.NewBinding(
			key.WithKeys("esc"),
			key.WithHelp("esc", "cancelar"),
		),
		Confirm: key.NewBinding(
			key.WithKeys("y", "s"),
			key.WithHelp("y", "confirmar"),
		),
		Reject: key.NewBinding(
			key.WithKeys("n"),
			key.WithHelp("n", "rejeitar"),
		),

		// Ações de tenant
		Add: key.NewBinding(
			key.WithKeys("a"),
			key.WithHelp("a", "adicionar"),
		),
		Edit: key.NewBinding(
			key.WithKeys("e"),
			key.WithHelp("e", "editar"),
		),
		Delete: key.NewBinding(
			key.WithKeys("d"),
			key.WithHelp("d", "deletar"),
		),
		Reset: key.NewBinding(
			key.WithKeys("r"),
			key.WithHelp("r", "resetar"),
		),
		Save: key.NewBinding(
			key.WithKeys("ctrl+s"),
			key.WithHelp("ctrl+s", "salvar"),
		),
		Search: key.NewBinding(
			key.WithKeys("/"),
			key.WithHelp("/", "buscar"),
		),
		Help: key.NewBinding(
			key.WithKeys("?"),
			key.WithHelp("?", "ajuda"),
		),
		Refresh: key.NewBinding(
			key.WithKeys("ctrl+r", "R"),
			key.WithHelp("ctrl+r", "atualizar"),
		),

		// Ações de formulário
		Next: key.NewBinding(
			key.WithKeys("tab"),
			key.WithHelp("tab", "próximo campo"),
		),
		Prev: key.NewBinding(
			key.WithKeys("shift+tab"),
			key.WithHelp("shift+tab", "campo anterior"),
		),
		Submit: key.NewBinding(
			key.WithKeys("enter"),
			key.WithHelp("enter", "enviar"),
		),
		Clear: key.NewBinding(
			key.WithKeys("ctrl+u"),
			key.WithHelp("ctrl+u", "limpar"),
		),

		// Navegação entre telas
		Quit: key.NewBinding(
			key.WithKeys("q", "ctrl+c"),
			key.WithHelp("q", "sair"),
		),
		BackScreen: key.NewBinding(
			key.WithKeys("esc", "h"),
			key.WithHelp("esc", "voltar"),
		),
	}
}

// ============================================================
// HELPERS DE VERIFICAÇÃO
// ============================================================
