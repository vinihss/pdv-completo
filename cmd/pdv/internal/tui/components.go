// components.go - Componentes reutilizáveis inspirados em Charm/Bubbles
package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ============================================================
// SPINNER - Indicador de loading animado
// ============================================================

// SpinnerModel encapsula um spinner do Bubbles com estado
type SpinnerModel struct {
	spinner  spinner.Model
	active   bool
	message  string
}

// NewSpinner cria um novo spinner com estilo Charm
func NewSpinner() SpinnerModel {
	s := spinner.New()
	s.Spinner = spinner.Dot // Estilo de pontos (similar ao Charm)
	s.Style = StatusInfoStyle
	return SpinnerModel{
		spinner: s,
		active:  false,
		message: "",
	}
}

// Start inicia o spinner com uma mensagem
func (m *SpinnerModel) Start(message string) tea.Cmd {
	m.active = true
	m.message = message
	return m.spinner.Tick
}

// Stop para o spinner
func (m *SpinnerModel) Stop() {
	m.active = false
	m.message = ""
}

// Update processa mensagens do spinner
func (m SpinnerModel) Update(msg tea.Msg) (SpinnerModel, tea.Cmd) {
	if !m.active {
		return m, nil
	}

	var cmd tea.Cmd
	m.spinner, cmd = m.spinner.Update(msg)
	return m, cmd
}

// View renderiza o spinner
func (m SpinnerModel) View() string {
	if !m.active {
		return ""
	}
	return fmt.Sprintf("%s %s", m.spinner.View(), StatusInfoStyle.Render(m.message))
}

// ============================================================
// MENU - Menu de seleção com cursor
// ============================================================

// MenuItem representa um item de menu
type MenuItem struct {
	Label       string
	Description string
	Action      string
}

// MenuModel representa um menu navegável
type MenuModel struct {
	items    []MenuItem
	cursor   int
	title    string
}

// NewMenu cria um novo menu
func NewMenu(title string, items []MenuItem) MenuModel {
	return MenuModel{
		items:  items,
		cursor: 0,
		title:  title,
	}
}

// SelectMove move o cursor para cima/baixo
func (m *MenuModel) SelectMove(delta int) {
	m.cursor += delta
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor >= len(m.items) {
		m.cursor = len(m.items) - 1
	}
}

// SelectedItem retorna o item atualmente selecionado
func (m *MenuModel) SelectedItem() *MenuItem {
	if len(m.items) == 0 {
		return nil
	}
	return &m.items[m.cursor]
}

// View renderiza o menu
func (m MenuModel) View() string {
	var b strings.Builder

	// Título
	if m.title != "" {
		b.WriteString(TitleStyle.Render(m.title))
		b.WriteString("\n\n")
	}

	// Itens do menu
	for i, item := range m.items {
		cursor := "  "
		style := MenuItemStyle
		if m.cursor == i {
			cursor = StatusInfoStyle.Render(IconCursor + " ")
			style = MenuItemSelectedStyle
		}

		// Label com descrição
		line := cursor + style.Render(item.Label)
		if item.Description != "" {
			line += HelpStyle.Render(" - " + item.Description)
		}
		b.WriteString(line + "\n")
	}

	return b.String()
}

// ============================================================
// LIST - Lista de itens com seleção
// ============================================================

// ListItem representa um item em uma lista
type ListItem struct {
	Primary   string
	Secondary string
	Status    string
	Metadata  map[string]string
}

// ListModel representa uma lista navegável
type ListModel struct {
	items    []ListItem
	cursor   int
	title    string
	emptyMsg string
}

// NewList cria uma nova lista
func NewList(title, emptyMsg string) ListModel {
	return ListModel{
		items:    []ListItem{},
		cursor:   0,
		title:    title,
		emptyMsg: emptyMsg,
	}
}

// SetItems atualiza os itens da lista
func (m *ListModel) SetItems(items []ListItem) {
	m.items = items
	if m.cursor >= len(items) {
		m.cursor = max(0, len(items)-1)
	}
}

// MoveCursor move o cursor para cima/baixo
func (m *ListModel) MoveCursor(delta int) {
	if len(m.items) == 0 {
		return
	}
	m.cursor += delta
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor >= len(m.items) {
		m.cursor = len(m.items) - 1
	}
}

// SelectedItem retorna o item atualmente selecionado
func (m *ListModel) SelectedItem() *ListItem {
	if len(m.items) == 0 {
		return nil
	}
	return &m.items[m.cursor]
}

// View renderiza a lista
func (m ListModel) View() string {
	var b strings.Builder

	// Título
	if m.title != "" {
		b.WriteString(TitleStyle.Render(m.title))
		b.WriteString("\n\n")
	}

	// Lista vazia
	if len(m.items) == 0 {
		b.WriteString(HelpStyle.Render(m.emptyMsg))
		return b.String()
	}

	// Itens da lista
	for i, item := range m.items {
		cursor := "  "
		if m.cursor == i {
			cursor = StatusInfoStyle.Render(IconCursor + " ")
		}

		// Ícone de status
		statusIcon := StatusIcon(item.Status)

		// Linha principal
		line := cursor + statusIcon + " " + item.Primary
		if item.Secondary != "" {
			line += HelpStyle.Render(" (" + item.Secondary + ")")
		}
		b.WriteString(line + "\n")
	}

	return b.String()
}

// ============================================================
// FORM - Formulário com campos navegáveis
// ============================================================

// FormField representa um campo de formulário
type FormField struct {
	Label       string
	Value       string
	Placeholder string
	Required    bool
	Multiline   bool
}

// FormModel representa um formulário navegável
type FormModel struct {
	fields  []FormField
	cursor  int
	title   string
}

// NewForm cria um novo formulário
func NewForm(title string, fields []FormField) FormModel {
	return FormModel{
		fields: fields,
		cursor: 0,
		title:  title,
	}
}

// NextField move para o próximo campo
func (m *FormModel) NextField() {
	if m.cursor < len(m.fields)-1 {
		m.cursor++
	}
}

// PrevField move para o campo anterior
func (m *FormModel) PrevField() {
	if m.cursor > 0 {
		m.cursor--
	}
}

// SetValue define o valor do campo atual
func (m *FormModel) SetValue(value string) {
	if m.cursor < len(m.fields) {
		m.fields[m.cursor].Value = value
	}
}

// AppendChar adiciona um caractere ao campo atual
func (m *FormModel) AppendChar(char string) {
	if m.cursor < len(m.fields) {
		m.fields[m.cursor].Value += char
	}
}

// DeleteChar remove o último caractere do campo atual
func (m *FormModel) DeleteChar() {
	if m.cursor < len(m.fields) && len(m.fields[m.cursor].Value) > 0 {
		m.fields[m.cursor].Value = m.fields[m.cursor].Value[:len(m.fields[m.cursor].Value)-1]
	}
}

// Validate valida os campos obrigatórios
func (m *FormModel) Validate() error {
	for _, field := range m.fields {
		if field.Required && strings.TrimSpace(field.Value) == "" {
			return fmt.Errorf("campo '%s' é obrigatório", field.Label)
		}
	}
	return nil
}

// View renderiza o formulário
func (m FormModel) View() string {
	var b strings.Builder

	// Título
	if m.title != "" {
		b.WriteString(TitleStyle.Render(m.title))
		b.WriteString("\n\n")
	}

	// Campos do formulário
	for i, field := range m.fields {
		cursor := "  "
		labelStyle := FieldLabelStyle
		valueStyle := FieldValueStyle

		if m.cursor == i {
			cursor = StatusInfoStyle.Render(IconCursor + " ")
			labelStyle = FieldSelectedStyle
			valueStyle = FieldSelectedStyle
		}

		// Label
		label := field.Label
		if field.Required {
			label += StatusErrorStyle.Render(" *")
		}

		// Valor ou placeholder
		value := field.Value
		if value == "" {
			value = HelpStyle.Render("[" + field.Placeholder + "]")
		} else {
			value = valueStyle.Render(value)
		}

		line := cursor + labelStyle.Render(label) + ": " + value
		b.WriteString(line + "\n")
	}

	return b.String()
}

// ============================================================
// HELP BAR - Barra de ajuda no rodapé
// ============================================================

// HelpBarModel representa uma barra de ajuda
type HelpBarModel struct {
	items []HelpItem
}

// HelpItem representa um item de ajuda (tecla + descrição)
type HelpItem struct {
	Key  string
	Desc string
}

// NewHelpBar cria uma nova barra de ajuda
func NewHelpBar(items []HelpItem) HelpBarModel {
	return HelpBarModel{items: items}
}

// View renderiza a barra de ajuda
func (m HelpBarModel) View() string {
	if len(m.items) == 0 {
		return ""
	}

	var parts []string
	for _, item := range m.items {
		parts = append(parts, HelpKeyStyle.Render(item.Key)+" "+HelpDescStyle.Render(item.Desc))
	}

	content := strings.Join(parts, "  "+HelpStyle.Render("•")+"  ")
	return StatusBarStyle.Render("\n" + content)
}

// ============================================================
// STATUS BAR - Barra de status com mensagens
// ============================================================

// StatusBarModel representa uma barra de status
type StatusBarModel struct {
	message  string
	msgType  StatusType
}

// NewStatusBar cria uma nova barra de status
func NewStatusBar() StatusBarModel {
	return StatusBarModel{}
}

// SetMessage define uma mensagem na barra de status
func (m *StatusBarModel) SetMessage(message string, msgType StatusType) {
	m.message = message
	m.msgType = msgType
}

// Clear limpa a mensagem
func (m *StatusBarModel) Clear() {
	m.message = ""
}

// View renderiza a barra de status
func (m StatusBarModel) View() string {
	if m.message == "" {
		return ""
	}

	var style lipgloss.Style
	switch m.msgType {
	case StatusSuccess:
		style = StatusSuccessStyle
	case StatusError:
		style = StatusErrorStyle
	case StatusWarning:
		style = StatusWarningStyle
	default:
		style = StatusInfoStyle
	}

	icon := IconInfo
	switch m.msgType {
	case StatusSuccess:
		icon = IconSuccess
	case StatusError:
		icon = IconError
	case StatusWarning:
		icon = IconWarning
	}

	content := fmt.Sprintf("%s %s", style.Render(icon), style.Render(m.message))
	return StatusBarStyle.Render("\n" + content)
}

// ============================================================
// HELPERS
// ============================================================

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
