// Package tui implementa a interface interativa do PDV CLI usando Bubble Tea.
//
// A TUI fornece um menu-driven interface para gerenciamento de tenants,
// substituindo a necessidade de decorar subcomandos e flags. Toda operação
// disponível via CLI tradicional está acessível aqui com feedback visual
// em tempo real.
package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"pdv-cli/internal/ops"
)

// Model principal da TUI. Segue o padrão Elm (Model-Update-View).
// Mantém o estado atual da aplicação: qual tela está ativa, tenants
// carregados, operação em andamento, etc.
type Model struct {
	// Estado da navegação
	screen    Screen
	tenantIdx int
	actionIdx int

	// Dados
	tenants    []Tenant
	selected   *Tenant
	loading    bool
	statusMsg  string
	statusType StatusType

	// Formulários
	form      FormModel
	formMode  FormMode
	confirm   bool
	confirmFn func() tea.Cmd
}

// Screen define as telas disponíveis na TUI.
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

// StatusType define o tipo de mensagem de status (para colorização).
type StatusType int

const (
	StatusInfo StatusType = iota
	StatusSuccess
	StatusWarning
	StatusError
)

// Tenant representa um tenant carregado do registry.
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

// StoreConfig representa as configurações da loja (store_settings).
type StoreConfig struct {
	MerchantName    string
	PrintEnabled    bool
	AutoPrint       bool
	DeliveryEnabled bool
	WhatsAppEnabled bool
}

// FormModel mantém o estado do formulário ativo.
type FormModel struct {
	fields    []FormField
	fieldIdx  int
	submitted bool
}

// FormField representa um campo editável no formulário.
type FormField struct {
	Label       string
	Value       string
	Placeholder string
	Required    bool
	Multiline   bool
}

// FormMode define qual formulário está ativo.
type FormMode int

const (
	FormNone FormMode = iota
	FormAddTenant
	FormEditTenant
	FormAddUser
	FormResetPIN
	FormEditConfig
)

// Mensagens do sistema (eventos que atualizam o model).
type (
	tenantsLoadedMsg struct {
		tenants []Tenant
		err     error
	}
	tenantCreatedMsg struct {
		tenant Tenant
		err    error
	}
	tenantUpdatedMsg struct {
		tenant Tenant
		err    error
	}
	actionCompletedMsg struct {
		action string
		err    error
	}
	statusMsg struct {
		msg  string
		typ  StatusType
	}
)

// NewModel cria um model inicial com a tela de menu.
func NewModel() Model {
	return Model{
		screen:  ScreenMenu,
		loading: false,
	}
}

// Init é chamado quando a TUI inicia. Pode retornar um Cmd para
// carregar dados iniciais (ex: listar tenants).
func (m Model) Init() tea.Cmd {
	return nil
}

// Update processa eventos (teclas, mensagens do sistema) e retorna
// o novo estado do model + comandos a executar.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKey(msg)

	case tenantsLoadedMsg:
		if msg.err != nil {
			m.statusMsg = fmt.Sprintf("Erro ao carregar tenants: %v", msg.err)
			m.statusType = StatusError
		} else {
			m.tenants = msg.tenants
			m.statusMsg = fmt.Sprintf("%d tenants carregados", len(msg.tenants))
			m.statusType = StatusSuccess
		}
		m.loading = false
		return m, nil

	case tenantCreatedMsg:
		m.loading = false
		if msg.err != nil {
			m.statusMsg = fmt.Sprintf("Erro ao criar tenant: %v", msg.err)
			m.statusType = StatusError
			return m, nil
		}
		m.statusMsg = fmt.Sprintf("Tenant '%s' criado com sucesso", msg.tenant.Slug)
		m.statusType = StatusSuccess
		m.screen = ScreenList
		// Recarrega a lista
		return m, m.loadTenantsCmd()

	case actionCompletedMsg:
		m.loading = false
		if msg.err != nil {
			m.statusMsg = fmt.Sprintf("Erro em %s: %v", msg.action, msg.err)
			m.statusType = StatusError
		} else {
			m.statusMsg = fmt.Sprintf("%s concluído com sucesso", msg.action)
			m.statusType = StatusSuccess
		}
		return m, nil

	case statusMsg:
		m.statusMsg = msg.msg
		m.statusType = msg.typ
		return m, nil
	}

	return m, nil
}

// handleKey processa entrada de teclado. A lógica varia conforme a tela ativa.
func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Ctrl+C sempre sai
	if msg.String() == "ctrl+c" {
		return m, tea.Quit
	}

	switch m.screen {
	case ScreenMenu:
		return m.handleMenuKey(msg)
	case ScreenList:
		return m.handleListKey(msg)
	case ScreenDetail:
		return m.handleDetailKey(msg)
	case ScreenAdd, ScreenEdit:
		return m.handleFormKey(msg)
	case ScreenConfirm:
		return m.handleConfirmKey(msg)
	}

	return m, nil
}

// handleMenuKey navega no menu principal.
func (m Model) handleMenuKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		return m, tea.Quit
	case "up", "k":
		if m.actionIdx > 0 {
			m.actionIdx--
		}
	case "down", "j":
		if m.actionIdx < 5 { // 6 opções no menu principal
			m.actionIdx++
		}
	case "enter":
		return m.executeMenuAction()
	}
	return m, nil
}

// executeMenuAction executa a ação selecionada no menu principal.
func (m Model) executeMenuAction() (tea.Model, tea.Cmd) {
	switch m.actionIdx {
	case 0: // Listar tenants
		m.screen = ScreenList
		m.loading = true
		return m, m.loadTenantsCmd()
	case 1: // Adicionar tenant
		m.screen = ScreenAdd
		m.formMode = FormAddTenant
		m.form = newTenantForm()
	case 2: // Status dos serviços
		m.statusMsg = "Verificando status dos serviços..."
		m.statusType = StatusInfo
		m.loading = true
		return m, m.checkServicesCmd()
	case 3: // Reset PIN
		if len(m.tenants) > 0 {
			m.screen = ScreenList
			m.loading = true
			return m, m.loadTenantsCmd()
		}
		m.statusMsg = "Nenhum tenant disponível. Carregue a lista primeiro."
		m.statusType = StatusWarning
	case 4: // Configurações
		m.statusMsg = "Selecione um tenant na lista para editar configurações"
		m.statusType = StatusInfo
	case 5: // Backup
		m.statusMsg = "Selecione um tenant na lista para fazer backup"
		m.statusType = StatusInfo
	}
	return m, nil
}

// handleListKey navega na lista de tenants.
func (m Model) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		m.screen = ScreenMenu
		m.actionIdx = 0
	case "up", "k":
		if m.tenantIdx > 0 {
			m.tenantIdx--
		}
	case "down", "j":
		if m.tenantIdx < len(m.tenants)-1 {
			m.tenantIdx++
		}
	case "enter":
		if len(m.tenants) > 0 {
			t := m.tenants[m.tenantIdx]
			m.selected = &t
			m.screen = ScreenDetail
		}
	case "a":
		m.screen = ScreenAdd
		m.formMode = FormAddTenant
		m.form = newTenantForm()
	}
	return m, nil
}

// handleDetailKey gerencia ações no detalhe do tenant.
func (m Model) handleDetailKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.selected == nil {
		m.screen = ScreenList
		return m, nil
	}

	switch msg.String() {
	case "q", "esc":
		m.screen = ScreenList
		m.selected = nil
	case "r":
		m.formMode = FormResetPIN
		m.screen = ScreenConfirm
		m.confirm = true
		m.confirmFn = m.resetPINCmd
	case "s":
		m.formMode = FormEditConfig
		m.screen = ScreenEdit
		m.form = newConfigForm(m.selected.StoreConfig)
	case "u":
		m.formMode = FormAddUser
		m.screen = ScreenAdd
		m.form = newUserForm()
	case "d":
		m.screen = ScreenConfirm
		m.confirm = true
		m.confirmFn = m.dumpTenantCmd
	}
	return m, nil
}

// handleFormKey gerencia entrada nos formulários.
func (m Model) handleFormKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.screen = ScreenList
		m.formMode = FormNone
	case "tab", "down":
		if m.form.fieldIdx < len(m.form.fields)-1 {
			m.form.fieldIdx++
		}
	case "shift+tab", "up":
		if m.form.fieldIdx > 0 {
			m.form.fieldIdx--
		}
	case "enter":
		return m.submitForm()
	case "backspace":
		if len(m.form.fields[m.form.fieldIdx].Value) > 0 {
			i := m.form.fieldIdx
			m.form.fields[i].Value = m.form.fields[i].Value[:len(m.form.fields[i].Value)-1]
		}
	default:
		if len(msg.String()) == 1 {
			i := m.form.fieldIdx
			m.form.fields[i].Value += msg.String()
		}
	}
	return m, nil
}

// handleConfirmKey gerencia confirmações de ações destrutivas.
func (m Model) handleConfirmKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "s":
		if m.confirmFn != nil {
			return m, m.confirmFn()
		}
		m.screen = ScreenList
	case "n", "esc", "q":
		m.screen = ScreenList
		m.confirm = false
		m.confirmFn = nil
	}
	return m, nil
}

// submitForm processa o envio de um formulário.
func (m Model) submitForm() (tea.Model, tea.Cmd) {
	// Valida campos obrigatórios
	for _, f := range m.form.fields {
		if f.Required && strings.TrimSpace(f.Value) == "" {
			m.statusMsg = fmt.Sprintf("Campo '%s' é obrigatório", f.Label)
			m.statusType = StatusError
			return m, nil
		}
	}

	m.loading = true
	m.screen = ScreenLoading

	switch m.formMode {
	case FormAddTenant:
		slug := m.form.fields[0].Value
		name := m.form.fields[1].Value
		return m, m.createTenantCmd(slug, name)
	case FormEditConfig:
		// TODO: implementar edição de config
		m.statusMsg = "Edição de config ainda não implementada"
		m.statusType = StatusWarning
		m.loading = false
		m.screen = ScreenDetail
	case FormAddUser:
		// TODO: implementar adição de usuário
		m.statusMsg = "Adição de usuário ainda não implementada"
		m.statusType = StatusWarning
		m.loading = false
		m.screen = ScreenDetail
	case FormResetPIN:
		if m.selected != nil {
			return m, m.resetPINCmd()
		}
	}

	return m, nil
}

// View renderiza a tela atual. Chamado após cada Update.
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

	// Adiciona barra de status no rodapé
	statusBar := m.viewStatusBar()

	return lipgloss.JoinVertical(lipgloss.Left, content, statusBar)
}

// viewMenu renderiza o menu principal.
func (m Model) viewMenu() string {
	title := titleStyle.Render("PDV - Gerenciamento de Tenants")

	menuItems := []string{
		"Listar tenants",
		"Adicionar novo tenant",
		"Status dos serviços",
		"Reset PIN do manager",
		"Editar configurações da loja",
		"Backup/dump do tenant",
	}

	var menu strings.Builder
	for i, item := range menuItems {
		cursor := "  "
		style := itemStyle
		if m.actionIdx == i {
			cursor = "▸ "
			style = selectedStyle
		}
		menu.WriteString(style.Render(cursor + item) + "\n")
	}

	help := helpStyle.Render("\n↑/↓ navegar • enter selecionar • q sair")

	return lipgloss.JoinVertical(lipgloss.Left, title, "\n"+menu.String(), help)
}

// viewList renderiza a lista de tenants.
func (m Model) viewList() string {
	title := titleStyle.Render("Tenants Cadastrados")

	if len(m.tenants) == 0 {
		return lipgloss.JoinVertical(lipgloss.Left,
			title,
			"\n"+helpStyle.Render("Nenhum tenant encontrado. Pressione 'a' para adicionar ou 'q' para voltar."))
	}

	var list strings.Builder
	for i, t := range m.tenants {
		cursor := "  "
		style := itemStyle
		if m.tenantIdx == i {
			cursor = "▸ "
			style = selectedStyle
		}

		status := statusStyle(t.Status)
		line := fmt.Sprintf("%s%s (%s) - %s", cursor, t.Name, t.Slug, status)
		list.WriteString(style.Render(line) + "\n")
	}

	help := helpStyle.Render("\n↑/↓ navegar • enter detalhes • a adicionar • q voltar")

	return lipgloss.JoinVertical(lipgloss.Left, title, "\n"+list.String(), help)
}

// viewDetail renderiza os detalhes do tenant selecionado.
func (m Model) viewDetail() string {
	if m.selected == nil {
		return helpStyle.Render("Nenhum tenant selecionado")
	}

	t := m.selected
	title := titleStyle.Render(fmt.Sprintf("Tenant: %s", t.Name))

	info := fmt.Sprintf(`
Slug:        %s
Subdomínio:  %s
Status:      %s
Criado em:   %s
`,
		infoStyle.Render(t.Slug),
		infoStyle.Render(t.Subdomain),
		statusStyle(t.Status),
		infoStyle.Render(t.CreatedAt),
	)

	actions := `
Ações disponíveis:
  r - Reset PIN do manager
  s - Editar configurações da loja
  u - Adicionar usuário
  d - Backup/dump do tenant
`

	help := helpStyle.Render("\nPressione a letra da ação ou 'q' para voltar")

	return lipgloss.JoinVertical(lipgloss.Left, title, info, actions, help)
}

// viewForm renderiza um formulário de edição.
func (m Model) viewForm() string {
	var title string
	if m.formMode == FormAddTenant {
		title = titleStyle.Render("Adicionar Novo Tenant")
	} else {
		title = titleStyle.Render("Editar Configurações")
	}

	var form strings.Builder
	for i, field := range m.form.fields {
		cursor := "  "
		style := fieldStyle
		if m.form.fieldIdx == i {
			cursor = "▸ "
			style = selectedFieldStyle
		}

		value := field.Value
		if value == "" {
			value = helpStyle.Render(field.Placeholder)
		}

		line := fmt.Sprintf("%s%s: %s", cursor, field.Label, value)
		form.WriteString(style.Render(line) + "\n")
	}

	help := helpStyle.Render("\ntab/↓ próximo • shift+tab/↑ anterior • enter salvar • esc cancelar")

	return lipgloss.JoinVertical(lipgloss.Left, title, "\n"+form.String(), help)
}

// viewConfirm renderiza uma tela de confirmação.
func (m Model) viewConfirm() string {
	title := titleStyle.Render("Confirmação")

	var action string
	switch m.formMode {
	case FormResetPIN:
		action = "resetar o PIN do manager"
	case FormEditConfig:
		action = "editar as configurações"
	default:
		action = "executar esta ação"
	}

	msg := fmt.Sprintf("\nTem certeza que deseja %s?", action)
	help := helpStyle.Render("\ny/s confirmar • n/esc cancelar")

	return lipgloss.JoinVertical(lipgloss.Left, title, msg, help)
}

// viewLoading renderiza uma tela de carregamento.
func (m Model) viewLoading() string {
	title := titleStyle.Render("Processando...")
	msg := helpStyle.Render("\nAguarde enquanto a operação é executada.")
	return lipgloss.JoinVertical(lipgloss.Left, title, msg)
}

// viewStatusBar renderiza a barra de status no rodapé.
func (m Model) viewStatusBar() string {
	if m.statusMsg == "" {
		return ""
	}

	var style lipgloss.Style
	switch m.statusType {
	case StatusSuccess:
		style = successStyle
	case StatusError:
		style = errorStyle
	case StatusWarning:
		style = warningStyle
	default:
		style = infoStyle
	}

	return "\n" + style.Render(m.statusMsg)
}

// Command factories - criam comandos assíncronos para executar operações.

// loadTenantsCmd carrega a lista de tenants do backend.
func (m Model) loadTenantsCmd() tea.Cmd {
	return func() tea.Msg {
		tenants, err := ops.ListTenants()
		if err != nil {
			return tenantsLoadedMsg{
				tenants: []Tenant{},
				err:     err,
			}
		}

		// Converte ops.TenantInfo para tui.Tenant
		converted := make([]Tenant, len(tenants))
		for i, t := range tenants {
			converted[i] = Tenant{
				ID:        t.ID,
				Slug:      t.Slug,
				Name:      t.Subdomain, // Usa subdomain como nome
				Status:    t.Status,
				Subdomain: t.Subdomain,
				CreatedAt: t.CreatedAt,
			}
		}

		return tenantsLoadedMsg{
			tenants: converted,
			err:     nil,
		}
	}
}

// createTenantCmd cria um novo tenant.
func (m Model) createTenantCmd(slug, name string) tea.Cmd {
	return func() tea.Msg {
		err := ops.CreateTenant(slug, name)
		if err != nil {
			return tenantCreatedMsg{
				tenant: Tenant{},
				err:    err,
			}
		}

		return tenantCreatedMsg{
			tenant: Tenant{
				Slug: slug,
				Name: name,
			},
			err: nil,
		}
	}
}

// checkServicesCmd verifica o status dos serviços.
func (m Model) checkServicesCmd() tea.Cmd {
	return func() tea.Msg {
		services, err := ops.CheckServices()
		if err != nil {
			return actionCompletedMsg{
				action: "Verificação de serviços",
				err:    err,
			}
		}

		// Formata mensagem com status dos serviços
		var statusLines []string
		for name, state := range services {
			statusLines = append(statusLines, fmt.Sprintf("%s: %s", name, state))
		}

		return actionCompletedMsg{
			action: fmt.Sprintf("Serviços: %s", strings.Join(statusLines, ", ")),
			err:    nil,
		}
	}
}

// resetPINCmd reseta o PIN do manager do tenant selecionado.
func (m Model) resetPINCmd() tea.Cmd {
	return func() tea.Msg {
		if m.selected == nil {
			return actionCompletedMsg{
				action: "Reset de PIN",
				err:    fmt.Errorf("nenhum tenant selecionado"),
			}
		}

		newPIN, err := ops.ResetManagerPIN(m.selected.Slug, "")
		if err != nil {
			return actionCompletedMsg{
				action: "Reset de PIN",
				err:    err,
			}
		}

		return actionCompletedMsg{
			action: fmt.Sprintf("Reset de PIN concluído. Novo PIN: %s", newPIN),
			err:    nil,
		}
	}
}

// dumpTenantCmd faz backup/dump do tenant selecionado.
func (m Model) dumpTenantCmd() tea.Cmd {
	return func() tea.Msg {
		if m.selected == nil {
			return actionCompletedMsg{
				action: "Backup do tenant",
				err:    fmt.Errorf("nenhum tenant selecionado"),
			}
		}

		outputFile := fmt.Sprintf("/tmp/tenant-%s-dump.sql", m.selected.Slug)
		err := ops.DumpTenant(m.selected.Slug, outputFile)
		if err != nil {
			return actionCompletedMsg{
				action: "Backup do tenant",
				err:    err,
			}
		}

		return actionCompletedMsg{
			action: fmt.Sprintf("Backup criado em: %s", outputFile),
			err:    nil,
		}
	}
}

// Form constructors - criam formulários pré-preenchidos.

// newTenantForm cria um formulário para adicionar novo tenant.
func newTenantForm() FormModel {
	return FormModel{
		fields: []FormField{
			{
				Label:       "Slug (identificador)",
				Placeholder: "ex: umami-sushi",
				Required:    true,
			},
			{
				Label:       "Nome de exibição",
				Placeholder: "ex: Umami Sushi Arte",
				Required:    true,
			},
		},
		fieldIdx: 0,
	}
}

// newUserForm cria um formulário para adicionar novo usuário.
func newUserForm() FormModel {
	return FormModel{
		fields: []FormField{
			{
				Label:       "Nome do usuário",
				Placeholder: "ex: João Silva",
				Required:    true,
			},
			{
				Label:       "Perfil (waiter/kitchen/manager/cashier/courier)",
				Placeholder: "ex: waiter",
				Required:    true,
			},
			{
				Label:       "PIN (4-6 dígitos, vazio para gerar automático)",
				Placeholder: "ex: 1234",
				Required:    false,
			},
		},
		fieldIdx: 0,
	}
}

// newConfigForm cria um formulário para editar configurações da loja.
func newConfigForm(config *StoreConfig) FormModel {
	if config == nil {
		config = &StoreConfig{}
	}

	boolToStr := func(b bool) string {
		if b {
			return "true"
		}
		return "false"
	}

	return FormModel{
		fields: []FormField{
			{
				Label:       "Nome do comerciante",
				Value:       config.MerchantName,
				Placeholder: "ex: Umami Sushi Arte",
				Required:    true,
			},
			{
				Label:       "Impressão habilitada (true/false)",
				Value:       boolToStr(config.PrintEnabled),
				Placeholder: "false",
				Required:    true,
			},
			{
				Label:       "Impressão automática (true/false)",
				Value:       boolToStr(config.AutoPrint),
				Placeholder: "false",
				Required:    true,
			},
			{
				Label:       "Entrega habilitada (true/false)",
				Value:       boolToStr(config.DeliveryEnabled),
				Placeholder: "false",
				Required:    true,
			},
			{
				Label:       "WhatsApp habilitado (true/false)",
				Value:       boolToStr(config.WhatsAppEnabled),
				Placeholder: "false",
				Required:    true,
			},
		},
		fieldIdx: 0,
	}
}

// Style definitions - estilos visuais usando Lip Gloss.
var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#FAFAFA")).
			Background(lipgloss.Color("#7D56F4")).
			Padding(0, 1)

	itemStyle = lipgloss.NewStyle().
			PaddingLeft(2)

	selectedStyle = lipgloss.NewStyle().
			PaddingLeft(1).
			Foreground(lipgloss.Color("#7D56F4")).
			Bold(true)

	fieldStyle = lipgloss.NewStyle().
			PaddingLeft(2)

	selectedFieldStyle = lipgloss.NewStyle().
				PaddingLeft(1).
				Foreground(lipgloss.Color("#7D56F4")).
				Bold(true)

	infoStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#00BFFF"))

	successStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#00FF00")).
			Bold(true)

	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FF0000")).
			Bold(true)

	warningStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFFF00")).
			Bold(true)

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#666666")).
			Italic(true)
)

// statusStyle retorna o estilo apropriado para o status do tenant.
func statusStyle(status string) lipgloss.Style {
	switch status {
	case "active":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#00FF00"))
	case "suspended":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#FFFF00"))
	case "inactive":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#FF0000"))
	default:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#999999"))
	}
}
