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
//
// Operações assíncronas passam pelo Backend (local ou remoto), então as
// mesmas telas atendem os dois modos.
package tui

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"pdv-cli/internal/config"
	"pdv-cli/internal/ops"
	"pdv-cli/internal/ssh"
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
	ScreenConnect
	ScreenDeploy
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
	FormRenameTenant
	FormToggleStatus
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
		pin    string
		err    error
	}
	actionCompletedMsg struct {
		action string
		err    error
	}
	settingsLoadedMsg struct {
		config *StoreConfig
		err    error
	}
	settingsUpdatedMsg struct {
		config *StoreConfig
		err    error
	}
	tenantRenamedMsg struct {
		slug string
		name string
		err  error
	}
	statusChangedMsg struct {
		slug   string
		status string
		err    error
	}
	backupDoneMsg struct {
		target string
		paths  []string
		err    error
	}
	deployLineMsg struct {
		line string
		ch   chan deployEvent
	}
	deployDoneMsg struct {
		ch  chan deployEvent
		err error
	}
)

// deployEvent é um evento do stream de um deploy SSH.
type deployEvent struct {
	line string
	err  error
	done bool
}

// deployRunner executa um comando remoto entregando a saída linha a linha.
// *ssh.Client satisfaz a interface; os testes injetam um fake.
type deployRunner interface {
	Run(ctx context.Context, command string, onLine func(string)) error
}

// maxDeployLines limita quantas linhas do stream o model retém.
const maxDeployLines = 500

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
	backend  Backend
	tenants  []Tenant
	selected *Tenant

	// Componentes reutilizáveis
	menu      MenuModel
	list      ListModel
	form      FormModel
	helpBar   HelpBarModel
	confirmFn func() tea.Cmd
	formMode  FormMode

	// Deploy via SSH
	deployCh        chan deployEvent
	deployLines     []string
	deployErr       error
	deployRunning   bool
	deployArmed     bool
	newDeployRunner func(host string, port int, user, keyPath string) deployRunner
}

// NewModel cria um model inicial na tela de conexão. Sem conexão, o usuário
// pode seguir no modo local (tecla l). O backend default é o local.
func NewModel() Model {
	m := Model{
		screen:    ScreenConnect,
		keys:      DefaultKeyMap(),
		spinner:   NewSpinner(),
		statusBar: NewStatusBar(),
		list:      NewList("Tenants Cadastrados", "Nenhum tenant encontrado. Pressione 'a' para adicionar."),
	}
	m = m.withBackend(newLocalBackend())
	m.form = m.newConnectForm()
	m.formMode = FormNone
	m.helpBar = NewHelpBar(connectHelpItems())
	m.newDeployRunner = func(host string, port int, user, keyPath string) deployRunner {
		return ssh.New(host, port, user, keyPath)
	}
	return m
}

// withBackend troca o backend e reconstrói o menu e a barra de ajuda.
func (m Model) withBackend(b Backend) Model {
	m.backend = b
	if b.IsRemote() {
		m.menu = newRemoteMenu()
	} else {
		m.menu = newLocalMenu()
	}
	m.helpBar = NewHelpBar(defaultHelpItems())
	return m
}

// newLocalMenu mantém exatamente os itens do modo local atual.
func newLocalMenu() MenuModel {
	return NewMenu("PDV - Gerenciamento de Tenants", []MenuItem{
		{Label: "Listar tenants", Description: "ver todos os tenants cadastrados", Action: "list"},
		{Label: "Adicionar novo tenant", Description: "provisionar schema + migrations", Action: "add"},
		{Label: "Status dos serviços", Description: "verificar health dos containers", Action: "status"},
		{Label: "Reset PIN do manager", Description: "redefinir acesso de um tenant", Action: "reset-pin"},
		{Label: "Editar configurações", Description: "ajustar store_settings", Action: "edit-config"},
		{Label: "Backup/dump do tenant", Description: "exportar schema para SQL", Action: "dump"},
	})
}

// newRemoteMenu reorganiza o menu para operar um admin-server remoto.
func newRemoteMenu() MenuModel {
	return NewMenu("PDV - Administração Remota", []MenuItem{
		{Label: "Listar tenants", Description: "ver todos os tenants do servidor", Action: "list"},
		{Label: "Criar tenant", Description: "provisionar schema + migrations", Action: "add"},
		{Label: "Limpar cache", Description: "esvaziar o cache do Redis", Action: "cache"},
		{Label: "Backup do banco", Description: "backup do PostgreSQL no servidor", Action: "backup-db"},
		{Label: "Backup de arquivos", Description: "arquivos enviados no servidor", Action: "backup-files"},
		{Label: "Deploy (switch.sh)", Description: "rodar deploy azul/verde no host via SSH", Action: "deploy"},
		{Label: "Desconectar", Description: "voltar ao modo local", Action: "disconnect"},
	})
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
		if msg.pin != "" {
			m.statusBar.SetMessage(fmt.Sprintf("Tenant '%s' criado. PIN do manager: %s — anote agora", msg.tenant.Slug, msg.pin), StatusSuccess)
		} else {
			m.statusBar.SetMessage(fmt.Sprintf("Tenant '%s' criado com sucesso", msg.tenant.Slug), StatusSuccess)
		}
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

	case connectedMsg:
		m.spinner.Stop()
		if msg.err != nil {
			m.statusBar.SetMessage(msg.err.Error(), StatusError)
			return m, nil
		}
		m = m.withBackend(msg.backend)
		m.screen = ScreenMenu
		m.statusBar.SetMessage(fmt.Sprintf("Conectado ao servidor '%s'", msg.label), StatusSuccess)
		return m, nil

	case settingsLoadedMsg:
		m.spinner.Stop()
		if msg.err != nil {
			m.statusBar.SetMessage(fmt.Sprintf("Erro ao carregar configurações: %v", msg.err), StatusError)
			m.screen = ScreenDetail
			return m, nil
		}
		if m.selected != nil {
			m.selected.StoreConfig = msg.config
		}
		m.formMode = FormEditConfig
		m.form = m.newConfigForm(msg.config)
		m.screen = ScreenEdit
		return m, nil

	case settingsUpdatedMsg:
		m.spinner.Stop()
		if msg.err != nil {
			m.statusBar.SetMessage(fmt.Sprintf("Erro ao atualizar configurações: %v", msg.err), StatusError)
		} else {
			m.statusBar.SetMessage("Configurações atualizadas com sucesso", StatusSuccess)
			if m.selected != nil && msg.config != nil {
				m.selected.StoreConfig = msg.config
			}
		}
		m.screen = ScreenDetail
		return m, nil

	case tenantRenamedMsg:
		m.spinner.Stop()
		if msg.err != nil {
			m.statusBar.SetMessage(fmt.Sprintf("Erro ao renomear tenant: %v", msg.err), StatusError)
		} else {
			if m.selected != nil {
				m.selected.Name = msg.name
			}
			m.statusBar.SetMessage(fmt.Sprintf("Tenant '%s' renomeado", msg.slug), StatusSuccess)
		}
		m.screen = ScreenDetail
		return m, nil

	case statusChangedMsg:
		m.spinner.Stop()
		if msg.err != nil {
			m.statusBar.SetMessage(fmt.Sprintf("Erro ao alterar status: %v", msg.err), StatusError)
		} else {
			if m.selected != nil {
				m.selected.Status = msg.status
			}
			desc := "suspenso"
			if msg.status == "active" {
				desc = "ativo"
			}
			m.statusBar.SetMessage(fmt.Sprintf("Status do tenant '%s' alterado para %s", msg.slug, desc), StatusSuccess)
		}
		m.screen = ScreenDetail
		return m, nil

	case backupDoneMsg:
		m.spinner.Stop()
		switch {
		case msg.err != nil:
			m.statusBar.SetMessage(fmt.Sprintf("Erro no backup (%s): %v", msg.target, msg.err), StatusError)
		case len(msg.paths) > 0:
			m.statusBar.SetMessage(fmt.Sprintf("Backup (%s) concluído: %s", msg.target, joinStrings(msg.paths, ", ")), StatusSuccess)
		default:
			m.statusBar.SetMessage(fmt.Sprintf("Backup (%s) concluído", msg.target), StatusSuccess)
		}
		return m, nil

	case deployLineMsg:
		m.deployCh = msg.ch
		m.deployRunning = true
		m.deployLines = appendDeployLine(m.deployLines, msg.line)
		m.screen = ScreenDeploy
		m.helpBar = NewHelpBar(deployHelpItems(true))
		m.spinner.active = true
		m.spinner.message = "Deploy em andamento..."
		return m, waitDeployCmd(msg.ch)

	case deployDoneMsg:
		m.deployCh = msg.ch
		m.deployRunning = false
		m.deployErr = msg.err
		m.spinner.Stop()
		m.screen = ScreenDeploy
		m.helpBar = NewHelpBar(deployHelpItems(false))
		switch {
		case errors.Is(msg.err, context.Canceled):
			m.statusBar.SetMessage("Deploy abortado pelo usuário", StatusWarning)
		case msg.err != nil:
			m.statusBar.SetMessage(fmt.Sprintf("Deploy falhou: %v", msg.err), StatusError)
		default:
			m.statusBar.SetMessage("Deploy concluído com sucesso", StatusSuccess)
		}
		return m, nil
	}

	return m, spinnerCmd
}

// handleKey processa entrada de teclado
func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	keyStr := msg.String()

	// ctrl+c sempre sai; q sai em tudo exceto formulários e conexão (onde é
	// digitável)
	if keyStr == "ctrl+c" {
		return m, tea.Quit
	}
	if keyStr == "q" && m.screen != ScreenAdd && m.screen != ScreenEdit && m.screen != ScreenConnect && m.screen != ScreenDeploy {
		return m, tea.Quit
	}

	switch m.screen {
	case ScreenConnect:
		return m.handleConnectKey(msg)
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
	case ScreenDeploy:
		return m.handleDeployKey(keyStr)
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
	case "cache":
		m.spinner.Start("Limpando cache...")
		return m, m.clearCacheCmd()
	case "backup-db", "backup-files":
		m.spinner.Start("Executando backup...")
		return m, m.backupCmd(item.Action)
	case "deploy":
		return m.handleDeployMenuAction()
	case "disconnect":
		m = m.withBackend(newLocalBackend())
		m.helpBar = NewHelpBar(connectHelpItems())
		m.statusBar.SetMessage("Desconectado do servidor remoto", StatusInfo)
		m.screen = ScreenConnect
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
				m = m.selectTenant(m.tenants[idx])
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

	if m.backend != nil && m.backend.IsRemote() {
		return m.handleRemoteDetailKey(keyStr)
	}
	return m.handleLocalDetailKey(keyStr)
}

// handleRemoteDetailKey gerencia as ações do detalhe no modo remoto:
// e renomear · s settings · x habilitar/desabilitar · b backup do banco.
func (m Model) handleRemoteDetailKey(keyStr string) (tea.Model, tea.Cmd) {
	switch keyStr {
	case "esc", "h":
		m.screen = ScreenList
		m.selected = nil
	case "e":
		m.formMode = FormRenameTenant
		m.screen = ScreenEdit
		m.form = m.newRenameForm(m.selected)
	case "s":
		m.formMode = FormEditConfig
		m.spinner.Start("Carregando configurações...")
		m.screen = ScreenLoading
		return m, m.loadSettingsCmd(m.selected.Slug)
	case "x":
		m.formMode = FormToggleStatus
		m.screen = ScreenConfirm
		m.confirmFn = m.toggleStatusCmd
	case "b":
		m.spinner.Start("Executando backup do banco...")
		return m, m.backupCmd("db")
	}
	return m, nil
}

// handleLocalDetailKey mantém as ações do detalhe do modo local (r/s/u/d).
func (m Model) handleLocalDetailKey(keyStr string) (tea.Model, tea.Cmd) {
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
		if m.deployArmed {
			m = m.resetDeployState()
			m.screen = ScreenMenu
			return m, nil
		}
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
	case FormRenameTenant:
		if m.selected != nil {
			return m, m.renameTenantCmd(m.selected.Slug, m.form.fields[0].Value)
		}
	case FormEditConfig:
		return m, m.updateSettingsCmd(m.configFromForm())
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
		content = m.viewHeader() + "\n" + m.viewMenu()
	case ScreenList:
		content = m.viewHeader() + "\n" + m.viewList()
	case ScreenDetail:
		content = m.viewHeader() + "\n" + m.viewDetail()
	case ScreenConnect:
		content = m.viewConnect()
	case ScreenAdd, ScreenEdit:
		content = m.viewForm()
	case ScreenConfirm:
		content = m.viewConfirm()
	case ScreenLoading:
		content = m.viewLoading()
	case ScreenDeploy:
		content = m.viewHeader() + "\n" + m.viewDeploy()
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

// viewHeader mostra o servidor conectado no topo do menu, lista e detalhe.
func (m Model) viewHeader() string {
	label := "local"
	if m.backend != nil {
		label = m.backend.Label()
	}
	return SubtitleStyle.Render(fmt.Sprintf("PDV Admin — servidor: %s", label))
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
	if m.backend != nil && m.backend.IsRemote() {
		b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("e"), HelpDescStyle.Render("Renomear tenant")))
		b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("s"), HelpDescStyle.Render("Configurações da loja")))
		b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("x"), HelpDescStyle.Render("Habilitar/desabilitar")))
		b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("b"), HelpDescStyle.Render("Backup do banco")))
	} else {
		b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("r"), HelpDescStyle.Render("Reset PIN do manager")))
		b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("s"), HelpDescStyle.Render("Editar configurações da loja")))
		b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("u"), HelpDescStyle.Render("Adicionar usuário")))
		b.WriteString(fmt.Sprintf("  %s %s\n", HelpKeyStyle.Render("d"), HelpDescStyle.Render("Backup/dump do tenant")))
	}

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
	switch {
	case m.deployArmed:
		action = "executar o deploy azul/verde no host via SSH (bash deploy/switch.sh). A produção terá um deploy imediato"
	default:
		switch m.formMode {
		case FormResetPIN:
			action = "resetar o PIN do manager"
		case FormToggleStatus:
			action = "habilitar/desabilitar este tenant"
		case FormEditConfig:
			action = "editar as configurações"
		default:
			action = "executar esta ação"
		}
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

// viewDeploy renderiza a saída do deploy SSH em tempo real.
func (m Model) viewDeploy() string {
	var b strings.Builder

	b.WriteString(TitleStyle.Render("Deploy azul/verde (switch.sh)"))
	b.WriteString("\n")
	b.WriteString(SubtitleStyle.Render("Executado via SSH no host — saída em tempo real"))
	b.WriteString("\n\n")

	if len(m.deployLines) == 0 {
		b.WriteString(HelpStyle.Render("(sem saída ainda)"))
		b.WriteString("\n")
	} else {
		// Mostra só a cauda que cabe na tela (últimas 24 linhas).
		start := 0
		if len(m.deployLines) > 24 {
			start = len(m.deployLines) - 24
		}
		for _, line := range m.deployLines[start:] {
			b.WriteString(FieldValueStyle.Render(line))
			b.WriteString("\n")
		}
	}

	if m.deployErr != nil {
		b.WriteString("\n")
		b.WriteString(StatusErrorStyle.Render("Erro: "))
		b.WriteString(HelpStyle.Render(m.deployErr.Error()))
		b.WriteString("\n")
	}

	return b.String()
}

// ============================================================
// COMANDOS ASSÍNCRONOS
// ============================================================

// loadTenantsCmd carrega a lista de tenants pelo backend ativo
func (m Model) loadTenantsCmd() tea.Cmd {
	backend := m.backend
	return func() tea.Msg {
		tenants, err := backend.ListTenants()
		if err != nil {
			return tenantsLoadedMsg{tenants: []Tenant{}, err: err}
		}
		return tenantsLoadedMsg{tenants: tenants, err: nil}
	}
}

// createTenantCmd cria um novo tenant (o PIN do manager, quando houver, vem
// na mensagem e é exibido uma única vez).
func (m Model) createTenantCmd(slug, name string) tea.Cmd {
	backend := m.backend
	return func() tea.Msg {
		pin, err := backend.CreateTenant(slug, name)
		if err != nil {
			return tenantCreatedMsg{tenant: Tenant{}, err: err}
		}
		return tenantCreatedMsg{tenant: Tenant{Slug: slug, Name: name}, pin: pin, err: nil}
	}
}

// loadSettingsCmd carrega as configurações da loja de um tenant.
func (m Model) loadSettingsCmd(slug string) tea.Cmd {
	backend := m.backend
	return func() tea.Msg {
		cfg, err := backend.GetSettings(slug)
		return settingsLoadedMsg{config: cfg, err: err}
	}
}

// updateSettingsCmd persiste as configurações da loja pelo backend ativo.
func (m Model) updateSettingsCmd(cfg *StoreConfig) tea.Cmd {
	backend := m.backend
	slug := ""
	if m.selected != nil {
		slug = m.selected.Slug
	}
	patch := storeConfigPatch(cfg)
	return func() tea.Msg {
		err := backend.UpdateSettings(slug, patch)
		return settingsUpdatedMsg{config: cfg, err: err}
	}
}

// renameTenantCmd renomeia um tenant no modo remoto.
func (m Model) renameTenantCmd(slug, name string) tea.Cmd {
	backend := m.backend
	return func() tea.Msg {
		err := backend.RenameTenant(slug, name)
		return tenantRenamedMsg{slug: slug, name: name, err: err}
	}
}

// toggleStatusCmd alterna um tenant entre ativo e suspenso.
func (m Model) toggleStatusCmd() tea.Cmd {
	backend := m.backend
	slug, status := "", ""
	if m.selected != nil {
		slug = m.selected.Slug
		status = "suspended"
		if m.selected.Status == "suspended" {
			status = "active"
		}
	}
	return func() tea.Msg {
		err := backend.SetTenantStatus(slug, status)
		return statusChangedMsg{slug: slug, status: status, err: err}
	}
}

// clearCacheCmd limpa o cache do Redis no servidor remoto.
func (m Model) clearCacheCmd() tea.Cmd {
	backend := m.backend
	return func() tea.Msg {
		err := backend.ClearCache()
		return actionCompletedMsg{action: "Limpeza de cache", err: err}
	}
}

// backupCmd dispara um backup (db|files) no backend ativo.
func (m Model) backupCmd(target string) tea.Cmd {
	backend := m.backend
	return func() tea.Msg {
		paths, err := backend.Backup(target)
		return backupDoneMsg{target: target, paths: paths, err: err}
	}
}

// ============================================================
// DEPLOY VIA SSH
// ============================================================

// handleDeployMenuAction valida a configuração SSH do servidor conectado e, se
// completa, arma a confirmação do deploy. Sem SSH configurado, só orienta.
func (m Model) handleDeployMenuAction() (tea.Model, tea.Cmd) {
	if m.backend == nil || !m.backend.IsRemote() {
		m.statusBar.SetMessage("O deploy via SSH exige um servidor remoto conectado", StatusError)
		return m, nil
	}

	cfg, err := config.GetServer(m.backend.Label())
	if err != nil {
		m.statusBar.SetMessage(fmt.Sprintf("servidor '%s' não encontrado em servers.json: %v", m.backend.Label(), err), StatusError)
		return m, nil
	}
	if cfg.Host == "" || cfg.User == "" || cfg.KeyPath == "" || cfg.RemotePath == "" {
		m.statusBar.SetMessage(
			fmt.Sprintf("SSH do deploy não configurado para '%s': rode 'pdv connect %s <url> <token> --host <host> --port <porta> --user <user> --key <chave> --deploy-dir <repo-no-host>'", m.backend.Label(), m.backend.Label()),
			StatusError,
		)
		return m, nil
	}

	m.deployArmed = true
	m.confirmFn = m.startDeployCmd
	m.screen = ScreenConfirm
	return m, nil
}

// startDeployCmd monta o runner SSH e dispara o deploy, devolvendo um comando
// que consome o primeiro evento do stream.
func (m Model) startDeployCmd() tea.Cmd {
	cfg, err := config.GetServer(m.backend.Label())
	if err != nil {
		return func() tea.Msg {
			return deployDoneMsg{err: fmt.Errorf("servidor '%s' não encontrado em servers.json: %w", m.backend.Label(), err)}
		}
	}
	if cfg.Host == "" || cfg.User == "" || cfg.KeyPath == "" || cfg.RemotePath == "" {
		return func() tea.Msg {
			return deployDoneMsg{err: fmt.Errorf("SSH do servidor '%s' incompleto: rode 'pdv connect %s <url> <token> --host ... --user ... --key ... --deploy-dir ...'", m.backend.Label(), m.backend.Label())}
		}
	}

	runner := m.newDeployRunner(cfg.Host, cfg.Port, cfg.User, cfg.KeyPath)
	command := "bash " + cfg.RemotePath + "/deploy/switch.sh"

	ch := make(chan deployEvent, 128)
	m.deployCh = ch

	go func() {
		err := runner.Run(context.Background(), command, func(line string) {
			ch <- deployEvent{line: line}
		})
		ch <- deployEvent{done: true, err: err}
		close(ch)
	}()

	return waitDeployCmd(ch)
}

// waitDeployCmd lê um evento do canal de deploy e o converte numa mensagem.
func waitDeployCmd(ch chan deployEvent) tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return deployDoneMsg{ch: ch}
		}
		if ev.done {
			return deployDoneMsg{ch: ch, err: ev.err}
		}
		return deployLineMsg{line: ev.line, ch: ch}
	}
}

// handleDeployKey trata a tecla na tela de deploy. Enquanto roda, esc não sai;
// depois de terminar, esc volta ao menu e limpa o estado.
func (m Model) handleDeployKey(keyStr string) (tea.Model, tea.Cmd) {
	if keyStr != "esc" {
		return m, nil
	}
	if m.deployRunning {
		m.statusBar.SetMessage("Deploy em andamento — aguarde terminar para voltar", StatusWarning)
		return m, nil
	}
	m = m.resetDeployState()
	m.screen = ScreenMenu
	return m, nil
}

// resetDeployState limpa o estado do deploy e restaura a ajuda padrão.
func (m Model) resetDeployState() Model {
	m.deployCh = nil
	m.deployLines = nil
	m.deployErr = nil
	m.deployRunning = false
	m.deployArmed = false
	m.confirmFn = nil
	m.helpBar = NewHelpBar(defaultHelpItems())
	return m
}

// deployHelpItems descreve o atalho da tela de deploy conforme o estado.
func deployHelpItems(running bool) []HelpItem {
	desc := "voltar ao menu"
	if running {
		desc = "aguarde terminar para voltar"
	}
	return []HelpItem{{Key: "esc", Desc: desc}}
}

// appendDeployLine acrescenta linha ao buffer, mantendo no máximo
// maxDeployLines (descarta as mais antigas).
func appendDeployLine(lines []string, line string) []string {
	if len(lines) < maxDeployLines {
		return append(lines, line)
	}
	copy(lines, lines[1:])
	lines[len(lines)-1] = line
	return lines
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

// dumpTenantCmd faz backup do tenant pelo backend (modo local: dump local).
func (m Model) dumpTenantCmd() tea.Cmd {
	backend := m.backend
	return func() tea.Msg {
		paths, err := backend.Backup("db")
		if err != nil {
			return actionCompletedMsg{action: "Backup do tenant", err: err}
		}

		return actionCompletedMsg{
			action: fmt.Sprintf("Backup criado em: %s", joinStrings(paths, ", ")),
			err:    nil,
		}
	}
}

// ============================================================
// HELPERS
// ============================================================

// selectTenant associa o tenant selecionado ao estado e ao backend (quando o
// backend precisa saber o tenant, como no dump local).
func (m Model) selectTenant(t Tenant) Model {
	m.selected = &t
	if sel, ok := m.backend.(tenantSelector); ok {
		sel.SelectTenant(t.Slug)
	}
	return m
}

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

// newRenameForm cria formulário para renomear tenant (modo remoto).
func (m Model) newRenameForm(t *Tenant) FormModel {
	name := ""
	if t != nil {
		name = t.Name
	}
	return NewForm("Renomear Tenant", []FormField{
		{Label: "Nome de exibição", Value: name, Placeholder: "ex: Umami Sushi Arte", Required: true},
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

// configFromForm converte os campos do formulário de configurações em
// StoreConfig.
func (m Model) configFromForm() *StoreConfig {
	return &StoreConfig{
		MerchantName:    m.form.fields[0].Value,
		PrintEnabled:    parseBool(m.form.fields[1].Value),
		AutoPrint:       parseBool(m.form.fields[2].Value),
		DeliveryEnabled: parseBool(m.form.fields[3].Value),
		WhatsAppEnabled: parseBool(m.form.fields[4].Value),
	}
}

// parseBool converte string em bool, tolerando inválidos como false.
func parseBool(s string) bool {
	v, err := strconv.ParseBool(strings.TrimSpace(s))
	if err != nil {
		return false
	}
	return v
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
