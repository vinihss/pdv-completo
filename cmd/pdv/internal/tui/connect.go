package tui

import (
	"context"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"pdv-cli/internal/config"
	"pdv-cli/internal/remote"
)

// connectedMsg é entregue quando a tentativa de conexão remota termina.
type connectedMsg struct {
	label   string
	backend Backend
	err     error
}

// newConnectForm cria o formulário de conexão (nome, url, token).
func (m Model) newConnectForm() FormModel {
	return NewForm("Conectar a um Admin Server", []FormField{
		{Label: "Nome", Placeholder: "ex: producao", Required: true},
		{Label: "URL", Placeholder: "ex: https://admin.exemplo.com", Required: true},
		{Label: "Token", Placeholder: "token do admin-server", Required: true},
	})
}

// connectHelpItems descrevem os atalhos da tela de conexão.
func connectHelpItems() []HelpItem {
	return []HelpItem{
		{Key: "enter", Desc: "conectar"},
		{Key: "l", Desc: "modo local"},
		{Key: "q", Desc: "sair"},
	}
}

// viewConnect renderiza a primeira tela (sem conexão).
func (m Model) viewConnect() string {
	return m.form.View()
}

// connectCmd valida o admin-server (health + tenants), salva em
// servers.json e devolve o backend remoto pronto.
func (m Model) connectCmd(name, url, token string) tea.Cmd {
	return func() tea.Msg {
		client := remote.New(url, token)
		ctx := context.Background()

		if _, err := client.Health(ctx); err != nil {
			return connectedMsg{err: fmt.Errorf("não foi possível alcançar %s: %w", client.BaseURL(), err)}
		}
		if _, err := client.ListTenants(ctx); err != nil {
			return connectedMsg{err: fmt.Errorf("token rejeitado por %s: %w", client.BaseURL(), err)}
		}
		if err := config.UpsertServer(name, client.BaseURL(), token); err != nil {
			return connectedMsg{err: fmt.Errorf("falha ao salvar servidor %s: %w", name, err)}
		}

		return connectedMsg{
			label:   name,
			backend: newRemoteBackend(name, client),
		}
	}
}

// handleConnectKey processa a entrada na tela de conexão.
func (m Model) handleConnectKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	keyStr := msg.String()

	// Atalhos especiais só valem enquanto o formulário está vazio: senão 'l' e
	// 'q' seriam digitáveis em URLs como "localhost" ou "https://…".
	switch keyStr {
	case "ctrl+c":
		return m, tea.Quit
	case "tab", "down":
		if m.connectFormEmpty() {
			return m, nil
		}
		m.form.NextField()
		return m, nil
	case "shift+tab", "up":
		if !m.connectFormEmpty() {
			m.form.PrevField()
		}
		return m, nil
	case "backspace":
		m.form.DeleteChar()
		return m, nil
	case "ctrl+u":
		m.form.SetValue("")
		return m, nil
	case "enter":
		return m.submitConnect()
	}

	if keyStr == "l" && m.connectFormEmpty() {
		m = m.withBackend(newLocalBackend())
		m.screen = ScreenMenu
		m.statusBar.SetMessage("Modo local ativo", StatusInfo)
		return m, nil
	}
	if keyStr == "q" && m.connectFormEmpty() {
		return m, tea.Quit
	}
	if len(keyStr) == 1 {
		m.form.AppendChar(keyStr)
	}
	return m, nil
}

// submitConnect valida os campos e dispara a conexão remota.
func (m Model) submitConnect() (tea.Model, tea.Cmd) {
	if err := m.form.Validate(); err != nil {
		m.statusBar.SetMessage(err.Error(), StatusError)
		return m, nil
	}

	name := m.form.fields[0].Value
	url := m.form.fields[1].Value
	token := m.form.fields[2].Value

	m.spinner.Start("Conectando...")
	return m, m.connectCmd(name, url, token)
}

// connectFormEmpty diz se nenhum campo do formulário de conexão tem conteúdo.
func (m Model) connectFormEmpty() bool {
	for _, f := range m.form.fields {
		if strings.TrimSpace(f.Value) != "" {
			return false
		}
	}
	return true
}
