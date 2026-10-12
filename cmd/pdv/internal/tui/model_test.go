package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"pdv-cli/internal/config"
)

// fakeBackend implementa Backend para dirigir a TUI nos testes sem servidor.
type fakeBackend struct {
	remote        bool
	label         string
	tenants       []Tenant
	settings      *StoreConfig
	createPIN     string
	listErr       error
	createdSlug   string
	renamed       []string
	statusCalls   []string
	backupTargets []string
	clearCalls    int
}

func (f *fakeBackend) Label() string  { return f.label }
func (f *fakeBackend) IsRemote() bool { return f.remote }

func (f *fakeBackend) ListTenants() ([]Tenant, error) { return f.tenants, f.listErr }

func (f *fakeBackend) CreateTenant(slug, displayName string) (string, error) {
	f.createdSlug = slug
	return f.createPIN, nil
}

func (f *fakeBackend) RenameTenant(slug, displayName string) error {
	f.renamed = append(f.renamed, slug+"="+displayName)
	return nil
}

func (f *fakeBackend) SetTenantStatus(slug, status string) error {
	f.statusCalls = append(f.statusCalls, slug+":"+status)
	return nil
}

func (f *fakeBackend) GetSettings(string) (*StoreConfig, error) { return f.settings, nil }

func (f *fakeBackend) UpdateSettings(string, map[string]any) error { return nil }

func (f *fakeBackend) ClearCache() error {
	f.clearCalls++
	return nil
}

func (f *fakeBackend) Backup(target string) ([]string, error) {
	f.backupTargets = append(f.backupTargets, target)
	return []string{"/tmp/fake-dump.sql"}, nil
}

// press envia uma tecla para o model e devolve o model atualizado.
func press(t *testing.T, m Model, key string) (Model, tea.Cmd) {
	t.Helper()
	var msg tea.KeyMsg
	switch key {
	case "enter":
		msg = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		msg = tea.KeyMsg{Type: tea.KeyEsc}
	case "tab":
		msg = tea.KeyMsg{Type: tea.KeyTab}
	default:
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)}
	}
	updated, cmd := m.Update(msg)
	model, ok := updated.(Model)
	if !ok {
		t.Fatalf("Update devolveu %T, esperado Model", updated)
	}
	return model, cmd
}

// apply entrega uma mensagem assíncrona ao model.
func apply(t *testing.T, m Model, msg tea.Msg) Model {
	t.Helper()
	updated, _ := m.Update(msg)
	model, ok := updated.(Model)
	if !ok {
		t.Fatalf("Update devolveu %T, esperado Model", updated)
	}
	return model
}

// remoteModel devolve um model na tela de menu com o backend remoto fake.
func remoteModel(fb *fakeBackend) Model {
	fb.remote = true
	if fb.label == "" {
		fb.label = "prod"
	}
	m := NewModel()
	m = m.withBackend(fb)
	m.screen = ScreenMenu
	return m
}

func TestNewModelStartsOnConnect(t *testing.T) {
	m := NewModel()
	if m.screen != ScreenConnect {
		t.Fatalf("screen = %v, want ScreenConnect", m.screen)
	}
	if m.backend == nil || m.backend.IsRemote() {
		t.Fatalf("backend default deveria ser local, got %+v", m.backend)
	}
}

func TestConnectToLocalMenu(t *testing.T) {
	m, _ := press(t, NewModel(), "l")
	if m.screen != ScreenMenu {
		t.Fatalf("screen = %v, want ScreenMenu", m.screen)
	}
	if m.backend.IsRemote() || m.backend.Label() != "local" {
		t.Fatalf("backend = %+v, want local", m.backend)
	}
}

func TestConnectRemoteMenuViaFakeBackend(t *testing.T) {
	fb := &fakeBackend{remote: true, label: "prod"}

	m := apply(t, NewModel(), connectedMsg{label: "prod", backend: fb})
	if m.screen != ScreenMenu {
		t.Fatalf("screen = %v, want ScreenMenu", m.screen)
	}
	if !m.backend.IsRemote() || m.backend.Label() != "prod" {
		t.Fatalf("backend = %+v, want remote prod", m.backend)
	}
	if len(m.menu.items) != 7 || m.menu.items[2].Action != "cache" || m.menu.items[5].Action != "deploy" || m.menu.items[6].Action != "disconnect" {
		t.Fatalf("menu remoto inesperado: %+v", m.menu.items)
	}
}

func TestMenuToListTransition(t *testing.T) {
	fb := &fakeBackend{tenants: []Tenant{{Slug: "a", Name: "Loja A", Status: "active"}}}
	m := remoteModel(fb)

	m, cmd := press(t, m, "enter")
	if m.screen != ScreenList {
		t.Fatalf("screen = %v, want ScreenList", m.screen)
	}
	if cmd == nil {
		t.Fatal("esperado comando de carregamento de tenants")
	}

	m = apply(t, m, cmd())
	if len(m.tenants) != 1 || m.tenants[0].Name != "Loja A" {
		t.Fatalf("tenants = %+v", m.tenants)
	}
}

func TestListToDetailTransition(t *testing.T) {
	fb := &fakeBackend{tenants: []Tenant{{Slug: "a", Name: "Loja A", Status: "active"}}}
	m := remoteModel(fb)

	m, cmd := press(t, m, "enter") // menu -> list
	m = apply(t, m, cmd())         // carrega tenants
	m, _ = press(t, m, "enter")    // list -> detail

	if m.screen != ScreenDetail {
		t.Fatalf("screen = %v, want ScreenDetail", m.screen)
	}
	if m.selected == nil || m.selected.Slug != "a" {
		t.Fatalf("selected = %+v", m.selected)
	}
}

func TestDetailToggleStatusConfirm(t *testing.T) {
	fb := &fakeBackend{tenants: []Tenant{{Slug: "a", Name: "Loja A", Status: "active"}}}
	m := remoteModel(fb)

	m, cmd := press(t, m, "enter")
	m = apply(t, m, cmd())
	m, _ = press(t, m, "enter") // detail

	m, _ = press(t, m, "x")
	if m.screen != ScreenConfirm {
		t.Fatalf("screen = %v, want ScreenConfirm", m.screen)
	}

	m, cmd = press(t, m, "y")
	if cmd == nil {
		t.Fatal("esperado comando de confirmação")
	}
	m = apply(t, m, cmd())

	if len(fb.statusCalls) != 1 || fb.statusCalls[0] != "a:suspended" {
		t.Fatalf("statusCalls = %v, want [a:suspended]", fb.statusCalls)
	}
	if m.screen != ScreenDetail {
		t.Fatalf("screen = %v, want ScreenDetail", m.screen)
	}
	if m.selected == nil || m.selected.Status != "suspended" {
		t.Fatalf("selected.Status = %+v, want suspended", m.selected)
	}
}

func TestDetailRenameOpensForm(t *testing.T) {
	fb := &fakeBackend{tenants: []Tenant{{Slug: "a", Name: "Loja A", Status: "active"}}}
	m := remoteModel(fb)

	m, cmd := press(t, m, "enter")
	m = apply(t, m, cmd())
	m, _ = press(t, m, "enter") // detail

	m, _ = press(t, m, "e")
	if m.screen != ScreenEdit || m.formMode != FormRenameTenant {
		t.Fatalf("screen=%v formMode=%v, want ScreenEdit/FormRenameTenant", m.screen, m.formMode)
	}
}

func TestDetailSettingsLoadsThenForm(t *testing.T) {
	fb := &fakeBackend{
		tenants:  []Tenant{{Slug: "a", Name: "Loja A", Status: "active"}},
		settings: &StoreConfig{MerchantName: "Umami"},
	}
	m := remoteModel(fb)

	m, cmd := press(t, m, "enter")
	m = apply(t, m, cmd())
	m, _ = press(t, m, "enter") // detail

	m, cmd = press(t, m, "s")
	if m.screen != ScreenLoading {
		t.Fatalf("screen = %v, want ScreenLoading", m.screen)
	}
	if cmd == nil {
		t.Fatal("esperado comando de carregamento de configurações")
	}

	m = apply(t, m, cmd())
	if m.screen != ScreenEdit || m.formMode != FormEditConfig {
		t.Fatalf("screen=%v formMode=%v, want ScreenEdit/FormEditConfig", m.screen, m.formMode)
	}
	if m.form.fields[0].Value != "Umami" {
		t.Fatalf("campo nome = %q, want Umami", m.form.fields[0].Value)
	}
}

func TestRemoteCreateTenantShowsPINOnce(t *testing.T) {
	fb := &fakeBackend{createPIN: "1234"}
	m := remoteModel(fb)
	m.screen = ScreenAdd
	m.formMode = FormAddTenant
	m.form = m.newTenantForm()
	m.form.fields[0].Value = "umami"
	m.form.fields[1].Value = "Umami"

	m, cmd := press(t, m, "enter")
	if cmd == nil {
		t.Fatal("esperado comando de criação")
	}
	m = apply(t, m, cmd())

	if fb.createdSlug != "umami" {
		t.Fatalf("createdSlug = %q, want umami", fb.createdSlug)
	}
	if !strings.Contains(m.statusBar.message, "PIN do manager: 1234") {
		t.Fatalf("status = %q, esperado conter o PIN", m.statusBar.message)
	}
}

func TestMenuClearCacheCallsBackend(t *testing.T) {
	fb := &fakeBackend{}
	m := remoteModel(fb)
	m.menu.cursor = 2 // "Limpar cache"

	m, cmd := press(t, m, "enter")
	if cmd == nil {
		t.Fatal("esperado comando de limpeza de cache")
	}
	m = apply(t, m, cmd())
	if fb.clearCalls != 1 {
		t.Fatalf("clearCalls = %d, want 1", fb.clearCalls)
	}
}

func TestDisconnectReturnsToConnect(t *testing.T) {
	fb := &fakeBackend{}
	m := remoteModel(fb)
	m.menu.cursor = 6 // "Desconectar"

	m, _ = press(t, m, "enter")
	if m.screen != ScreenConnect {
		t.Fatalf("screen = %v, want ScreenConnect", m.screen)
	}
	if m.backend.IsRemote() {
		t.Fatalf("backend = %+v, want local após desconectar", m.backend)
	}
}

// ============================================================
// DEPLOY VIA SSH
// ============================================================

const deployMenuIndex = 5 // "Deploy (switch.sh)"

// fakeRunner simula um deploy SSH: registra o comando/config e emite linhas.
type fakeRunner struct {
	command string
	lines   []string
	err     error
}

func (f *fakeRunner) Run(_ context.Context, command string, onLine func(string)) error {
	f.command = command
	for _, l := range f.lines {
		onLine(l)
	}
	return f.err
}

// writeServer grava um servidor em ~/.pdv/servers.json (HOME temporário).
func writeServer(t *testing.T, s config.ServerConfig) {
	t.Helper()
	if err := config.AddServer(s); err != nil {
		t.Fatalf("AddServer: %v", err)
	}
}

// fullServer devolve um servidor com todos os campos SSH preenchidos.
func fullServer() config.ServerConfig {
	return config.ServerConfig{
		Name:       "prod",
		Host:       "10.0.0.50",
		Port:       2222,
		User:       "deploy",
		KeyPath:    "/home/deploy/.ssh/id_ed25519",
		RemotePath: "/srv/pdv",
	}
}

// updateModel entrega uma mensagem ao model e devolve model + próximo cmd.
func updateModel(t *testing.T, m Model, msg tea.Msg) (Model, tea.Cmd) {
	t.Helper()
	updated, cmd := m.Update(msg)
	model, ok := updated.(Model)
	if !ok {
		t.Fatalf("Update devolveu %T, esperado Model", updated)
	}
	return model, cmd
}

func TestDeployMenuActionRequiresSSHConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fb := &fakeBackend{remote: true, label: "prod"}
	writeServer(t, config.ServerConfig{Name: "prod", URL: "https://admin.example.com", Token: "t"})

	m := remoteModel(fb)
	m.menu.cursor = deployMenuIndex

	m, cmd := press(t, m, "enter")
	if cmd != nil {
		t.Fatalf("esperado nenhum comando sem SSH configurado, got %v", cmd)
	}
	if m.screen != ScreenMenu {
		t.Fatalf("screen = %v, want ScreenMenu", m.screen)
	}
	if !strings.Contains(m.statusBar.message, "--host") {
		t.Fatalf("status = %q, esperado orientação de configuração", m.statusBar.message)
	}
	if m.confirmFn != nil {
		t.Fatal("confirmFn não deveria estar armado sem SSH configurado")
	}
}

func TestDeployMenuActionOpensConfirm(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fb := &fakeBackend{remote: true, label: "prod"}
	writeServer(t, fullServer())

	m := remoteModel(fb)
	m.menu.cursor = deployMenuIndex

	m, _ = press(t, m, "enter")
	if m.screen != ScreenConfirm {
		t.Fatalf("screen = %v, want ScreenConfirm", m.screen)
	}
	if m.confirmFn == nil {
		t.Fatal("esperado confirmFn armado")
	}
}

func TestDeployStreamsLinesAndCompletes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fb := &fakeBackend{remote: true, label: "prod"}
	writeServer(t, fullServer())

	r := &fakeRunner{lines: []string{"linha 1", "linha 2"}}
	var gotHost, gotUser, gotKey string
	var gotPort int

	m := remoteModel(fb)
	m.newDeployRunner = func(host string, port int, user, keyPath string) deployRunner {
		gotHost, gotPort, gotUser, gotKey = host, port, user, keyPath
		return r
	}
	m.menu.cursor = deployMenuIndex

	m, _ = press(t, m, "enter") // ScreenConfirm
	m, cmd := press(t, m, "y")
	if cmd == nil {
		t.Fatal("esperado comando do deploy ao confirmar")
	}

	// Consome as linhas streamadas, uma mensagem por vez.
	for range r.lines {
		msg := cmd()
		m, cmd = updateModel(t, m, msg)
	}
	// Consome o evento final (done).
	m, _ = updateModel(t, m, cmd())

	if len(m.deployLines) != 2 || m.deployLines[0] != "linha 1" || m.deployLines[1] != "linha 2" {
		t.Fatalf("deployLines = %+v", m.deployLines)
	}
	if m.screen != ScreenDeploy {
		t.Fatalf("screen = %v, want ScreenDeploy", m.screen)
	}
	if m.deployRunning {
		t.Fatal("deployRunning deveria ser false após concluir")
	}
	if m.deployErr != nil {
		t.Fatalf("deployErr = %v, want nil", m.deployErr)
	}
	if !strings.Contains(m.statusBar.message, "sucesso") {
		t.Fatalf("status = %q, esperado sucesso", m.statusBar.message)
	}
	if r.command != "bash /srv/pdv/deploy/switch.sh" {
		t.Fatalf("comando = %q, want 'bash /srv/pdv/deploy/switch.sh'", r.command)
	}
	if gotHost != "10.0.0.50" || gotPort != 2222 || gotUser != "deploy" || gotKey != "/home/deploy/.ssh/id_ed25519" {
		t.Fatalf("config do runner = %s:%d %s %s", gotHost, gotPort, gotUser, gotKey)
	}
}

func TestDeployRunnerErrorSurfaces(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fb := &fakeBackend{remote: true, label: "prod"}
	writeServer(t, fullServer())

	r := &fakeRunner{lines: []string{"iniciando"}, err: errors.New("exit status 1")}

	m := remoteModel(fb)
	m.newDeployRunner = func(string, int, string, string) deployRunner { return r }
	m.menu.cursor = deployMenuIndex

	m, _ = press(t, m, "enter")
	m, cmd := press(t, m, "y")
	if cmd == nil {
		t.Fatal("esperado comando do deploy")
	}

	m, cmd = updateModel(t, m, cmd()) // linha
	m, _ = updateModel(t, m, cmd())   // done

	if m.deployErr == nil || !strings.Contains(m.deployErr.Error(), "exit status 1") {
		t.Fatalf("deployErr = %v, want exit status 1", m.deployErr)
	}
	if !strings.Contains(m.statusBar.message, "falhou") {
		t.Fatalf("status = %q, esperado falha", m.statusBar.message)
	}
	if m.deployRunning {
		t.Fatal("deployRunning deveria ser false após erro")
	}
}

func TestDeployEscReturnsToMenuAfterDone(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fb := &fakeBackend{remote: true, label: "prod"}
	writeServer(t, fullServer())

	m := remoteModel(fb)
	m.screen = ScreenDeploy
	m.deployLines = []string{"antiga"}
	m.deployRunning = false

	m, _ = press(t, m, "esc")
	if m.screen != ScreenMenu {
		t.Fatalf("screen = %v, want ScreenMenu", m.screen)
	}
	if m.deployLines != nil || m.deployRunning {
		t.Fatalf("estado do deploy não foi limpo: %+v", m.deployLines)
	}
}

func TestDeployQDoesNotQuitWhileRunning(t *testing.T) {
	fb := &fakeBackend{remote: true, label: "prod"}
	m := remoteModel(fb)
	m.screen = ScreenDeploy
	m.deployRunning = true

	if _, cmd := press(t, m, "q"); cmd != nil {
		t.Fatal("q não deveria encerrar a TUI durante o deploy")
	}
}
