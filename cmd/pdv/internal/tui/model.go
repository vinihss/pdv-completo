// Package tui implementa a interface interativa do PDV CLI usando Bubble Tea.
//
// Arquitetura inspirada em aplicações Charm (Glow, Wishlist, Soft Serve):
// - Componentes reutilizáveis (Menu, List, Form, Spinner)
// - Keybindings estilo Vim (j/k, h/l, g/G)
// - Tema visual rico com ícones Unicode e cores harmoniosas
// - Status bar persistente com ajuda contextual
// - State machine pattern para transições entre telas
//
// A TUI fornece uma interface menu-driven para gerenciamento de tenants,
// substituindo a necessidade de decorar subcomandos e flags. Toda operação
// disponível via CLI tradicional está acessível aqui com feedback visual
// em tempo real e animações suaves.
package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"pdv-cli/internal/ops"
)

// ============================================================
// TIPOS DE DADO
// ============================================================

// Screen define as telas disponíveis na TUI (state machine)
type Screen int

const (
	ScreenMenu Screen = iota
	ScreenList
	ScreenDetail
	ScreenAdd
	ScreenEdit
	ScreenConfirm
	ScreenLoading
)

// StatusType define o tipo de mensagem de status
type StatusType int

const (
	StatusInfo StatusType = iota
	StatusSuccess
	StatusWarning
	StatusError
)

// Tenant representa um tenant carregado do registry
type Tenant struct {
	ID          int
	Slug        string
	Name        string
	Status      string
	Subdomain   string
	CreatedAt   string
	ManagerPIN  string // apenas exibido após reset, nunca armazenado
	StoreConfig *StoreConfig
}

// StoreConfig representa as configurações da loja (store_settings)
type StoreConfig struct {
	MerchantName    string
	PrintEnabled    bool
	AutoPrint       bool
	DeliveryEnabled bool
	WhatsAppEnabled bool
}

// FormMode define qual formulário está ativo
type FormMode int

const (
	FormNone FormMode = iota
	FormAddTenant
	FormEditTenant
	FormAddUser
	FormResetPIN
	FormEditConfig
)

// ============================================================
// MENSAGENS DO SISTEMA
// ============================================================

type (
	tenantsLoadedMsg struct {
		tenants []Tenant
		err     error
	}
	tenantCreatedMsg struct {
		tenant Tenant
		err    error
	}
	actionCompletedMsg struct {
		action string
		err    error
	}
)

// ============================================================
// MODEL PRINCIPAL
// ============================================================

// Model é o estado central da TUI (padrão Elm)
type Model struct {
	// Navegação e estado
	screen    Screen
	keys      KeyMap
	spinner   SpinnerModel
	statusBar StatusBarModel

	// Dados
	tenants  []Tenant
	selected *Tenant

	// Componentes reutilizáveis
	menu       MenuModel
	list       ListModel
	form       FormModel
	helpBar    HelpBarModel
	confirmFn  func() tea.Cmd
	formMode   FormMode
}

// NewModel cria um model inicial com menu principal
func NewModel() Model {
	menu := NewMenu("PDV - Gerenciamento de Tenants", []MenuItem{
		{Label: "Listar tenants", Description: "ver todos os tenants cadastrados", Action: "list"},
		{Label: "Adicionar novo tenant", Description: "provisionar schema + migrations", Action: "add"},
		{Label: "Status dos serviços", Description: "verificar health dos containers", Action: "status"},
		{Label: "Reset PIN do manager", Description: "redefinir acesso de um tenant", Action: "reset-pin"},
		{Label: "Editar configurações", Description: "ajustar store_settings", Action: "edit-config"},
		{Label: "Backup/dump do tenant", Description: "exportar schema para SQL", Action: "dump"},
	})

	return Model{
		screen:    ScreenMenu,
		keys:      DefaultKeyMap(),
		spinner:   NewSpinner(),
		statusBar: NewStatusBar(),
		menu:      menu,
		list:      NewList("Tenants Cadastrados", "Nenhum tenant encontrado. Pressione 'a' para adicionar."),
		helpBar:   NewHelpBar(defaultHelpItems()),
	}
}

// defaultHelpItems retorna os itens de ajuda padrão
func defaultHelpItems() []HelpItem {
	return []HelpItem{
		{Key: "↑/↓", Desc: "navegar"},
		{Key: "enter", Desc: "selecionar"},
		{Key: "esc", Desc: "voltar"},
		{Key: "q", Desc: "sair"},
	}
}

// ============================================================
// INIT
// ============================================================

// Init é chamado quando a TUI inicia
func (m Model) Init() tea.Cmd {
	return nil
}

// ============================================================
// UPDATE
// ============================================================

// Update processa eventos e atualiza o estado
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	// Spinner sempre processa mensagens quando ativo
	var spinnerCmd tea.Cmd
	m.spinner, spinnerCmd = m.spinner.Update(msg)

	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKey(msg)

	case tea.WindowSizeMsg:
		// Redimensionamento de janela não precisa de tratamento especial
		return m, nil

	case tenantsLoadedMsg:
		m.spinner.Stop()
		if msg.err != nil {
			m.statusBar.SetMessage(fmt.Sprintf("Erro ao carregar tenants: %v", msg.err), StatusError)
		} else {
			m.tenants = msg.tenants
			m.list.SetItems(m.tenantsToListItems())
			m.statusBar.SetMessage(fmt.Sprintf("%d tenants carregados", len(msg.tenants)), StatusSuccess)
		}
		return m, nil

	case tenantCreatedMsg:
		m.spinner.Stop()
		if msg.err != nil {
			m.statusBar.SetMessage(fmt.Sprintf("Erro ao criar tenant: %v", msg.err), StatusError)
			return m, nil
		}
		m.statusBar.SetMessage(fmt.Sprintf("Tenant '%s' criado com sucesso", msg.tenant.Slug), StatusSuccess)
		m.screen = ScreenList
		// Recarrega a lista
		return m, tea.Batch(m.loadTenantsCmd(), spinnerCmd)

	case actionCompletedMsg:
		m.spinner.Stop()
		if msg.err != nil {
			m.statusBar.SetMessage(fmt.Sprintf("Erro em %s: %v", msg.action, msg.err), StatusError)
		} else {
			m.statusBar.SetMessage(fmt.Sprintf("%s concluído com sucesso", msg.action), StatusSuccess)
		}
		return m, nil
	}

	return m, spinnerCmd
}

// handleKey processa entrada de teclado
func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	keyStr := msg.String()

	// Quit sempre funciona (exceto em formulários)
	if m.screen != ScreenAdd && m.screen != ScreenEdit {
		if keyStr == "q" || keyStr == "ctrl+c" {
			return m, tea.Quit
		}
	}

	switch m.screen {
	case ScreenMenu:
		return m.handleMenuKey(keyStr)
	case ScreenList:
		return m.handleListKey(keyStr)
	case ScreenDetail:
		return m.handleDetailKey(keyStr)
	case ScreenAdd, ScreenEdit:
		return m.handleFormKey(msg)
	case ScreenConfirm:
		return m.handleConfirmKey(keyStr)
	case ScreenLoading:
		return m, nil
	}

	return m, nil
}

// handleMenuKey navega no menu principal
func (m Model) handleMenuKey(keyStr string) (tea.Model, tea.Cmd) {
	switch keyStr {
	case "up", "k":
		m.menu.SelectMove(-1)
	case "down", "j":
		m.menu.SelectMove(1)
	case "g":
		m.menu.cursor = 0
	case "G":
		m.menu.cursor = len(m.menu.items) - 1
	case "enter":
		return m.executeMenuAction()
	}
	return m, nil
}

// executeMenuAction executa a ação selecionada no menu
func (m Model) executeMenuAction() (tea.Model, tea.Cmd) {
	item := m.menu.SelectedItem()
	if item == nil {
		return m, nil
	}

	switch item.Action {
	case "list":
		m.screen = ScreenList
		m.spinner.Start("Carregando tenants...")
		return m, m.loadTenantsCmd()
	case "add":
		m.screen = ScreenAdd
		m.formMode = FormAddTenant
		m.form = m.newTenantForm()
	case "status":
		m.spinner.Start("Verificando status dos serviços...")
		return m, m.checkServicesCmd()
	case "reset-pin":
		if len(m.tenants) == 0 {
			m.statusBar.SetMessage("Nenhum tenant disponível. Carregue a lista primeiro.", StatusWarning)
		} else {
			m.screen = ScreenList
			m.spinner.Start("Carregando tenants...")
			return m, m.loadTenantsCmd()
		}
	case "edit-config":
		m.statusBar.SetMessage("Selecione um tenant na lista para editar configurações", StatusInfo)
	case "dump":
		m.statusBar.SetMessage("Selecione um tenant na lista para fazer backup", StatusInfo)
	}
	return m, nil
}

// handleListKey navega na lista de tenants
func (m Model) handleListKey(keyStr string) (tea.Model, tea.Cmd) {
	switch keyStr {
	case "esc", "h":
		m.screen = ScreenMenu
	case "up", "k":
		m.list.MoveCursor(-1)
	case "down", "j":
		m.list.MoveCursor(1)
	case "g":
		m.list.cursor = 0
	case "G":
		m.list.cursor = len(m.list.items) - 1
	case "enter":
		if item := m.list.SelectedItem(); item != nil {
			idx := m.list.cursor
			if idx < len(m.tenants) {
				t := m.tenants[idx]
				m.selected = &t
				m.screen = ScreenDetail
			}
		}
	case "a":
		m.screen = ScreenAdd
		m.formMode = FormAddTenant
		m.form = m.newTenantForm()
	case "ctrl+r", "R":
		m.spinner.Start("Atualizando lista...")
		return m, m.loadTenantsCmd()
	}
	return m, nil
}

// handleDetailKey gerencia ações no detalhe do tenant
func (m Model) handleDetailKey(keyStr string) (tea.Model, tea.Cmd) {
	if m.selected == nil {
		m.screen = ScreenList
		return m, nil
	}

	switch keyStr {
	case "esc", "h":
		m.screen = ScreenList
		m.selected = nil
	case "r":
		m.formMode = FormResetPIN
		m.screen = ScreenConfirm
		m.confirmFn = m.resetPINCmd
	case "s":
		m.formMode = FormEditConfig
		m.screen = ScreenEdit
		m.form = m.newConfigForm(m.selected.StoreConfig)
	case "u":
		m.formMode = FormAddUser
		m.screen = ScreenAdd
		m.form = m.newUserForm()
	case "d":
		m.screen = ScreenConfirm
		m.confirmFn = m.dumpTenantCmd
	}
	return m, nil
}

// handleFormKey gerencia entrada nos formulários
func (m Model) handleFormKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	keyStr := msg.String()
	switch keyStr {
	case "esc":
		m.screen = ScreenList
		m.formMode = FormNone
	case "tab", "down":
		m.form.NextField()
	case "shift+tab", "up":
		m.form.PrevField()
	case "enter":
		return m.submitForm()
	case "backspace":
		m.form.DeleteChar()
	case "ctrl+u":
		m.form.SetValue("")
	default:
		if len(keyStr) == 1 {
			m.form.AppendChar(keyStr)
		}
	}
	return m, nil
}

// handleConfirmKey gerencia confirmações
func (m Model) handleConfirmKey(keyStr string) (tea.Model, tea.Cmd) {
	switch keyStr {
	case "y", "s":
		if m.confirmFn != nil {
			m.spinner.Start("Processando...")
			return m, m.confirmFn()
		}
		m.screen = ScreenList
	case "n", "esc", "q":
		m.screen = ScreenList
		m.confirmFn = nil
	}
	return m, nil
}

// submitForm processa o envio de um formulário
func (m Model) submitForm() (tea.Model, tea.Cmd) {
	if err := m.form.Validate(); err != nil {
		m.statusBar.SetMessage(err.Error(), StatusError)
		return m, nil
	}

	m.spinner.Start("Processando...")
	m.screen = ScreenLoading

	switch m.formMode {
	case FormAddTenant:
		slug := m.form.fields[0].Value
		name := m.form.fields[1].Value
		return m, m.createTenantCmd(slug, name)
	case FormEditConfig:
		m.statusBar.SetMessage("Edição de config ainda não implementada", StatusWarning)
		m.spinner.Stop()
		m.screen = ScreenDetail
	case FormAddUser:
		m.statusBar.SetMessage("Adição de usuário ainda não implementada", StatusWarning)
		m.spinner.Stop()
		m.screen = ScreenDetail
	case FormResetPIN:
		if m.selected != nil {
			return m, m.resetPINCmd()
		}
	}

	return m, nil
}

// ============================================================
// VIEW
// ============================================================

// View renderiza a tela atual
func (m Model) View() string {
	var content string

	switch m.screen {
	case ScreenMenu:
		content = m.viewMenu()
	case ScreenList:
		content = m.viewList()
	case ScreenDetail:
		content = m.viewDetail()
	case ScreenAdd, ScreenEdit:
		content = m.viewForm()
	case ScreenConfirm:
		content = m.viewConfirm()
	case ScreenLoading:
		content = m.viewLoading()
	}

	// Monta a tela final: conteúdo + status bar + help bar
	var parts []string
	parts = append(parts, content)

	if spinnerView := m.spinner.View(); spinnerView != "" {
		parts = append(parts, spinnerView)
	}

	if statusView := m.statusBar.View(); statusView != "" {
		parts = append(parts, statusView)
	}

	parts = append(parts, m.helpBar.View())

	result := ""
	for _, part := range parts {
		if part != "" {
			result += part + "\n"
		}
	}
	return result
}

// viewMenu renderiza o menu principal
func (m Model) viewMenu() string {
	return m.menu.View()
}

// viewList renderiza a lista de tenants
func (m Model) viewList() string {
	return m.list.View()
}

// viewDetail renderiza os detalhes do tenant selecionado
func (m Model) viewDetail() string {
	if m.selected == nil {
		return HelpStyle.Render("Nenhum tenant selecionado")
	}

	t := m.selected
	var b strings.Builder

	// Título
	b.WriteString(TitleStyle.Render(fmt.Sprintf("Tenant: %s", t.Name)))
	b.WriteString("\n\n")

	// Informações
	b.WriteString(SubtitleStyle.Render("Informações"))
	b.WriteString("\n")
	b.WriteString(fmt.Sprintf("  %s %s\n", FieldLabelStyle.Render("Slug:"), FieldValueStyle.Render(t.Slug)))
	b.WriteString(fmt.Sprintf("  %s %s\n", FieldLabelStyle.Render("Subdomínio:"), FieldValueStyle.Render(t.Subdomain)))
	b.WriteString(fmt.Sprintf("  %s %s\n", FieldLabelStyle.Render("Status:"), StatusText(t.Status)))
	b.WriteString(fmt.Sprintf("  %s %s\n", FieldLabelStyle.Render("Criado em:"), FieldValueStyle.Render(t.CreatedAt)))
	b.WriteString("\n")

	// Ações disponíveis
	b.WriteString(SubtitleStyle.Render("Ações disponíveis"))
	b.WriteString("\n")
	b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("r"), HelpDescStyle.Render("Reset PIN do manager")))
	b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("s"), HelpDescStyle.Render("Editar configurações da loja")))
	b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("u"), HelpDescStyle.Render("Adicionar usuário")))
	b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("d"), HelpDescStyle.Render("Backup/dump do tenant")))

	return b.String()
}

// viewForm renderiza um formulário
func (m Model) viewForm() string {
	return m.form.View()
}

// viewConfirm renderiza tela de confirmação
func (m Model) viewConfirm() string {
	var b strings.Builder

	b.WriteString(TitleStyle.Render("Confirmação"))
	b.WriteString("\n\n")

	var action string
	switch m.formMode {
	case FormResetPIN:
		action = "resetar o PIN do manager"
	case FormEditConfig:
		action = "editar as configurações"
	default:
		action = "executar esta ação"
	}

	b.WriteString(fmt.Sprintf("Tem certeza que deseja %s?\n\n", action))
	b.WriteString(HelpKeyStyle.Render("y") + " " + HelpDescStyle.Render("confirmar"))
	b.WriteString("  ")
	b.WriteString(HelpKeyStyle.Render("n") + " " + HelpDescStyle.Render("cancelar"))

	return b.String()
}

// viewLoading renderiza tela de carregamento
func (m Model) viewLoading() string {
	return m.spinner.View()
}

// ============================================================
// COMANDOS ASSÍNCRONOS
// ============================================================

// loadTenantsCmd carrega a lista de tenants
func (m Model) loadTenantsCmd() tea.Cmd {
	return func() tea.Msg {
		tenants, err := ops.ListTenants()
		if err != nil {
			return tenantsLoadedMsg{tenants: []Tenant{}, err: err}
		}

		converted := make([]Tenant, len(tenants))
		for i, t := range tenants {
			converted[i] = Tenant{
				ID:        t.ID,
				Slug:      t.Slug,
				Name:      t.Subdomain,
				Status:    t.Status,
				Subdomain: t.Subdomain,
				CreatedAt: t.CreatedAt,
			}
		}

		return tenantsLoadedMsg{tenants: converted, err: nil}
	}
}

// createTenantCmd cria um novo tenant
func (m Model) createTenantCmd(slug, name string) tea.Cmd {
	return func() tea.Msg {
		err := ops.CreateTenant(slug, name)
		if err != nil {
			return tenantCreatedMsg{tenant: Tenant{}, err: err}
		}
		return tenantCreatedMsg{tenant: Tenant{Slug: slug, Name: name}, err: nil}
	}
}

// checkServicesCmd verifica o status dos serviços
func (m Model) checkServicesCmd() tea.Cmd {
	return func() tea.Msg {
		services, err := ops.CheckServices()
		if err != nil {
			return actionCompletedMsg{action: "Verificação de serviços", err: err}
		}

		var statusLines []string
		for name, state := range services {
			statusLines = append(statusLines, fmt.Sprintf("%s: %s", name, state))
		}

		return actionCompletedMsg{
			action: fmt.Sprintf("Serviços: %s", joinStrings(statusLines, ", ")),
			err:    nil,
		}
	}
}

// resetPINCmd reseta o PIN do manager
func (m Model) resetPINCmd() tea.Cmd {
	return func() tea.Msg {
		if m.selected == nil {
			return actionCompletedMsg{action: "Reset de PIN", err: fmt.Errorf("nenhum tenant selecionado")}
		}

		newPIN, err := ops.ResetManagerPIN(m.selected.Slug, "")
		if err != nil {
			return actionCompletedMsg{action: "Reset de PIN", err: err}
		}

		return actionCompletedMsg{
			action: fmt.Sprintf("Reset de PIN concluído. Novo PIN: %s", newPIN),
			err:    nil,
		}
	}
}

// dumpTenantCmd faz backup do tenant
func (m Model) dumpTenantCmd() tea.Cmd {
	return func() tea.Msg {
		if m.selected == nil {
			return actionCompletedMsg{action: "Backup do tenant", err: fmt.Errorf("nenhum tenant selecionado")}
		}

		outputFile := fmt.Sprintf("/tmp/tenant-%s-dump.sql", m.selected.Slug)
		err := ops.DumpTenant(m.selected.Slug, outputFile)
		if err != nil {
			return actionCompletedMsg{action: "Backup do tenant", err: err}
		}

		return actionCompletedMsg{
			action: fmt.Sprintf("Backup criado em: %s", outputFile),
			err:    nil,
		}
	}
}

// ============================================================
// HELPERS
// ============================================================

// tenantsToListItems converte tenants para ListItem
func (m Model) tenantsToListItems() []ListItem {
	items := make([]ListItem, len(m.tenants))
	for i, t := range m.tenants {
		items[i] = ListItem{
			Primary:   t.Name,
			Secondary: t.Slug,
			Status:    t.Status,
		}
	}
	return items
}

// newTenantForm cria formulário para adicionar tenant
func (m Model) newTenantForm() FormModel {
	return NewForm("Adicionar Novo Tenant", []FormField{
		{Label: "Slug (identificador)", Placeholder: "ex: umami-sushi", Required: true},
		{Label: "Nome de exibição", Placeholder: "ex: Umami Sushi Arte", Required: true},
	})
}

// newUserForm cria formulário para adicionar usuário
func (m Model) newUserForm() FormModel {
	return NewForm("Adicionar Usuário", []FormField{
		{Label: "Nome do usuário", Placeholder: "ex: João Silva", Required: true},
		{Label: "Perfil", Placeholder: "waiter/kitchen/manager/cashier/courier", Required: true},
		{Label: "PIN (4-6 dígitos)", Placeholder: "vazio para gerar automático", Required: false},
	})
}

// newConfigForm cria formulário para editar configurações
func (m Model) newConfigForm(config *StoreConfig) FormModel {
	if config == nil {
		config = &StoreConfig{}
	}

	boolToStr := func(b bool) string {
		if b {
			return "true"
		}
		return "false"
	}

	return NewForm("Editar Configurações da Loja", []FormField{
		{Label: "Nome do comerciante", Value: config.MerchantName, Placeholder: "ex: Umami Sushi Arte", Required: true},
		{Label: "Impressão habilitada", Value: boolToStr(config.PrintEnabled), Placeholder: "true/false", Required: true},
		{Label: "Impressão automática", Value: boolToStr(config.AutoPrint), Placeholder: "true/false", Required: true},
		{Label: "Entrega habilitada", Value: boolToStr(config.DeliveryEnabled), Placeholder: "true/false", Required: true},
		{Label: "WhatsApp habilitado", Value: boolToStr(config.WhatsAppEnabled), Placeholder: "true/false", Required: true},
	})
}

// joinStrings junta strings com separador
func joinStrings(strs []string, sep string) string {
	result := ""
	for i, s := range strs {
		if i > 0 {
			result += sep
		}
		result += s
	}
	return result
}
