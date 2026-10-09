// styles.go - Tema visual completo inspirado em aplicações Charm (Glow, Wishlist, Soft Serve)
package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ============================================================
// PALETA DE CORES
// ============================================================
// Paleta harmoniosa inspirada em temas modernos de terminal
// Usa cores ANSI 256 para máxima compatibilidade
var (
	// Cores primárias - identidade visual
	ColorPrimary   = lipgloss.Color("#7C3AED") // Roxo vibrante (semelhante ao Charm)
	ColorSecondary = lipgloss.Color("#06B6D4") // Ciano para destaque
	ColorAccent    = lipgloss.Color("#F59E0B") // Âmbar para alertas

	// Cores semânticas - significado contextual
	ColorSuccess = lipgloss.Color("#10B981") // Verde esmeralda
	ColorError   = lipgloss.Color("#EF4444") // Vermelho
	ColorWarning = lipgloss.Color("#F59E0B") // Âmbar
	ColorInfo    = lipgloss.Color("#3B82F6") // Azul

	// Cores neutras - estrutura
	ColorForeground = lipgloss.Color("#FAFAFA") // Texto principal
	ColorMuted      = lipgloss.Color("#6B7280") // Texto secundário
	ColorSubtle     = lipgloss.Color("#4B5563") // Bordas sutis
	ColorBackground = lipgloss.Color("#1F2937") // Fundo de boxes

	// Cores de status
	ColorActive     = lipgloss.Color("#10B981") // Ativo/saudável
	ColorSuspended  = lipgloss.Color("#F59E0B") // Suspenso/alerta
	ColorInactive   = lipgloss.Color("#EF4444") // Inativo/erro
	ColorUnknown    = lipgloss.Color("#6B7280") // Desconhecido
)

// ============================================================
// ÍCONES UNICODE
// ============================================================
// Ícones consistentes para feedback visual
const (
	// Status
	IconActive    = "●" // Círculo cheio - ativo
	IconSuspended = "◌" // Círculo pontilhado - suspenso
	IconInactive  = "✗" // X - inativo
	IconUnknown   = "?" // Interrogação - desconhecido

	// Ações
	IconSuccess = "✓" // Check - sucesso
	IconError   = "✗" // X - erro
	IconWarning = "⚠" // Alerta
	IconInfo    = "ℹ" // Informação
	IconArrow   = "→" // Seta - navegação
	IconBullet  = "•" // Bolinha - lista

	// Navegação
	IconCursor  = "▸" // Cursor de seleção
	IconDivider = "─" // Divisor horizontal
	IconCorner  = "╭" // Canto de box
)

// ============================================================
// ESTILOS BASE
// ============================================================

// Title - título principal com destaque
var TitleStyle = lipgloss.NewStyle().
	Bold(true).
	Foreground(ColorForeground).
	Background(ColorPrimary).
	Padding(0, 2).
	MarginBottom(1)

// Subtitle - subtítulo secundário
var SubtitleStyle = lipgloss.NewStyle().
	Foreground(ColorSecondary).
	Bold(true).
	MarginBottom(1)

// MenuItem - item de menu padrão
var MenuItemStyle = lipgloss.NewStyle().
	PaddingLeft(2)

// MenuItemSelected - item de menu selecionado
var MenuItemSelectedStyle = lipgloss.NewStyle().
	PaddingLeft(1).
	Foreground(ColorPrimary).
	Bold(true)

// FieldLabel - label de campo de formulário
var FieldLabelStyle = lipgloss.NewStyle().
	Foreground(ColorMuted).
	PaddingRight(1)

// FieldValue - valor de campo
var FieldValueStyle = lipgloss.NewStyle().
	Foreground(ColorForeground)

// FieldSelected - campo selecionado
var FieldSelectedStyle = lipgloss.NewStyle().
	Foreground(ColorPrimary).
	Bold(true)

// Help - texto de ajuda/instruções
var HelpStyle = lipgloss.NewStyle().
	Foreground(ColorMuted).
	Italic(true)

// HelpKey - tecla de atalho em destaque
var HelpKeyStyle = lipgloss.NewStyle().
	Foreground(ColorSecondary).
	Bold(true)

// HelpDesc - descrição de atalho
var HelpDescStyle = lipgloss.NewStyle().
	Foreground(ColorMuted)

// ============================================================
// ESTILOS DE STATUS
// ============================================================

// StatusSuccess - mensagem de sucesso
var StatusSuccessStyle = lipgloss.NewStyle().
	Foreground(ColorSuccess).
	Bold(true)

// StatusError - mensagem de erro
var StatusErrorStyle = lipgloss.NewStyle().
	Foreground(ColorError).
	Bold(true)

// StatusWarning - mensagem de alerta
var StatusWarningStyle = lipgloss.NewStyle().
	Foreground(ColorWarning).
	Bold(true)

// StatusInfo - mensagem informativa
var StatusInfoStyle = lipgloss.NewStyle().
	Foreground(ColorInfo)

// ============================================================
// COMPONENTES DE LAYOUT
// ============================================================

// Box - container com borda
var BoxStyle = lipgloss.NewStyle().
	Border(lipgloss.RoundedBorder()).
	BorderForeground(ColorSubtle).
	Padding(1, 2).
	MarginBottom(1)

// BoxTitle - título dentro de box
var BoxTitleStyle = lipgloss.NewStyle().
	Foreground(ColorSecondary).
	Bold(true).
	MarginBottom(1)

// StatusBar - barra de status no rodapé
var StatusBarStyle = lipgloss.NewStyle().
	Border(lipgloss.NormalBorder(), true, false, false, false).
	BorderForeground(ColorSubtle).
	PaddingTop(1).
	MarginTop(1)

// ============================================================
// HELPERS DE RENDERIZAÇÃO
// ============================================================

// StatusIcon retorna o ícone apropriado para o status do tenant
func StatusIcon(status string) string {
	switch status {
	case "active":
		return StatusSuccessStyle.Render(IconActive)
	case "suspended":
		return StatusWarningStyle.Render(IconSuspended)
	case "inactive":
		return StatusErrorStyle.Render(IconInactive)
	default:
		return HelpStyle.Render(IconUnknown)
	}
}

// StatusText retorna o texto formatado para o status
func StatusText(status string) string {
	switch status {
	case "active":
		return StatusSuccessStyle.Render("ativo")
	case "suspended":
		return StatusWarningStyle.Render("suspenso")
	case "inactive":
		return StatusErrorStyle.Render("inativo")
	default:
		return HelpStyle.Render(status)
	}
}

// HelpBarText cria uma barra de ajuda com múltiplos itens separados por " • "
func HelpBarText(items ...string) string {
	return HelpStyle.Render(strings.Join(items, " • "))
}

// BoxedContent envolve conteúdo em um box com título opcional
func BoxedContent(title, content string) string {
	if title != "" {
		titledContent := BoxTitleStyle.Render(title) + "\n" + content
		return BoxStyle.Render(titledContent)
	}
	return BoxStyle.Render(content)
}

// Divider cria uma linha divisória
func Divider(width int) string {
	return HelpStyle.Render(strings.Repeat(IconDivider, width))
}

// BulletList cria uma lista com bullets
func BulletList(items []string) string {
	var lines []string
	for _, item := range items {
		lines = append(lines, HelpStyle.Render(IconBullet+" ") + item)
	}
	return strings.Join(lines, "\n")
}

// Indent adiciona indentação a cada linha
func Indent(text string, spaces int) string {
	indent := strings.Repeat(" ", spaces)
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if line != "" {
			lines[i] = indent + line
		}
	}
	return strings.Join(lines, "\n")
}

// Center centraliza texto horizontalmente
func Center(text string, width int) string {
	return lipgloss.PlaceHorizontal(width, lipgloss.Center, text)
}
