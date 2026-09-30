package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Estas regras nasceram de problema real de instalação: serviço do Windows
// com CWD em System32 e config escrito com caminho relativo.

func TestResolveDir(t *testing.T) {
	base := filepath.Join("C:", "ProgramData", "PDV Printer")
	cases := []struct {
		name        string
		value       string
		want        string
		onlyWindows bool
	}{
		{name: "vazio cai no padrão", value: "", want: filepath.Join(base, "data")},
		{name: "relativo ancora no config", value: "./fila", want: filepath.Join(base, "fila")},
		{name: "relativo sem ./", value: "fila", want: filepath.Join(base, "fila")},
		// Caminho com raiz é respeitado em todo S.O. No Windows o
		// filepath.IsAbs sozinho não pegaria "/srv/pdv/fila" (exige letra de
		// drive), e o daemon acabava lendo/gravando no diretório errado.
		{name: "absolutão é respeitado", value: "/srv/pdv/fila", want: "/srv/pdv/fila"},
		{name: "absolutão Windows", value: `C:\PDV\fila`, want: `C:\PDV\fila`, onlyWindows: true},
		{name: "absolutão Windows com barra invertida", value: `\PDV\fila`, want: `\PDV\fila`, onlyWindows: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.onlyWindows && runtime.GOOS != "windows" {
				t.Skip("semântica de caminho do Windows")
			}
			got := resolveDir(tc.value, base, "data")
			if got != tc.want {
				t.Fatalf("resolveDir(%q) = %q, quero %q", tc.value, got, tc.want)
			}
		})
	}
}

func TestResolveConfigPath(t *testing.T) {
	t.Setenv("PDV_PRINTER_CONFIG", "C:\\ProgramData\\PDV Printer\\config.json")
	cases := []struct {
		name string
		args []string
		want string
	}{
		{name: "flag --config", args: []string{"--config", `C:\PDV\config.json`}, want: `C:\PDV\config.json`},
		{name: "flag --config=...", args: []string{`--config=C:\PDV\outro.json`}, want: `C:\PDV\outro.json`},
		{name: "argumento solto", args: []string{`C:\PDV\solto.json`}, want: `C:\PDV\solto.json`},
		{name: "env quando não há flag", args: nil, want: "C:\\ProgramData\\PDV Printer\\config.json"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveConfigPath(tc.args); got != tc.want {
				t.Fatalf("resolveConfigPath(%v) = %q, quero %q", tc.args, got, tc.want)
			}
		})
	}
}

// Sem flag e sem env, o serviço precisa achar o config sozinho — é o caminho
// que o instalador usa, porque não passa argumento no binPath.
func TestResolveConfigPathSemEnvUsaProgramData(t *testing.T) {
	t.Setenv("PDV_PRINTER_CONFIG", "")
	if programData := os.Getenv("ProgramData"); programData != "" {
		want := filepath.Join(programData, "PDV Printer", "config.json")
		if got := resolveConfigPath(nil); got != want {
			t.Fatalf("resolveConfigPath(nil) = %q, quero %q", got, want)
		}
		return
	}
	// fora do Windows (dev) o padrão continua sendo o diretório de trabalho
	if got := resolveConfigPath(nil); got != "config.json" {
		t.Fatalf("fora do Windows o padrão deveria ser ./config.json, veio %q", got)
	}
}

func TestAllowedOriginsIncluiTauriSempre(t *testing.T) {
	got := allowedOrigins(Config{AllowedOrigins: []string{"http://localhost:3000"}})
	want := map[string]bool{
		"tauri://localhost":       true,
		"http://tauri.localhost":  true,
		"http://localhost:3000":   true,
		"https://tauri.localhost": true,
	}
	for origin := range want {
		if !contains(got, origin) {
			t.Fatalf("falta a origem %q em %v", origin, got)
		}
	}
	// duplicata do config não vira duplicata na lista
	dup := allowedOrigins(Config{AllowedOrigins: []string{"tauri://localhost"}})
	if len(dup) != len(builtinOrigins) {
		t.Fatalf("esperava %d origens sem repetir, veio %d: %v", len(builtinOrigins), len(dup), dup)
	}
}

func TestCORSLiberarOrigemDoTauri(t *testing.T) {
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), allowedOrigins(Config{}))

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("Origin", "http://tauri.localhost")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://tauri.localhost" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}

	// origem de um site qualquer continua bloqueada (sem header = browser nega)
	req = httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("Origin", "https://site-malvado.example")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("origem desconhecida passou: %q", got)
	}
}

func TestEnsureConfigCriaPadraoQuandoNaoExiste(t *testing.T) {
	path := filepath.Join(t.TempDir(), "PDV Printer", "config.json")
	cfg, err := ensureConfig(path)
	if err != nil {
		t.Fatalf("ensureConfig: %v", err)
	}
	if cfg.Listen != "127.0.0.1:8080" {
		t.Fatalf("listen = %q", cfg.Listen)
	}
	// o arquivo precisa ter nascido: o próximo restart tem que ler o mesmo
	// conteúdo, senão cada boot perde o que o cliente configurar
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("config não foi criado: %v", err)
	}
	reloaded, err := loadConfig(path)
	if err != nil {
		t.Fatalf("releitura: %v", err)
	}
	if reloaded.Listen != cfg.Listen || len(reloaded.Printers) != len(cfg.Printers) {
		t.Fatalf("config criado não relê igual: %+v", reloaded)
	}
	// impressora sem endereço não pode vir "pronta"
	if reloaded.Printers["kitchen"].Address != "" || !reloaded.Printers["kitchen"].Status {
		t.Fatalf("perfil de impressora deveria pedir configuração: %+v", reloaded.Printers["kitchen"])
	}
}

func TestEnsureConfigPreservaConfigDoCliente(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	conteudo := `{"listen":"127.0.0.1:9090","printers":{"cozinha":{"address":"192.168.0.9:9100"}}}`
	if err := os.WriteFile(path, []byte(conteudo), 0o640); err != nil {
		t.Fatal(err)
	}
	cfg, err := ensureConfig(path)
	if err != nil {
		t.Fatalf("ensureConfig: %v", err)
	}
	if cfg.Listen != "127.0.0.1:9090" {
		t.Fatalf("listen sobrescrito: %q", cfg.Listen)
	}
	if cfg.Printers["cozinha"].Address != "192.168.0.9:9100" {
		t.Fatalf("impressora do cliente perdida: %+v", cfg.Printers)
	}
}

// newTestDaemon monta o mesmo objeto que main() monta, com o banco em
// memória, para os testes exercitarem o caminho real (migrate inclusive).
func newTestDaemon(t *testing.T, cfg Config) *Daemon {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "fila.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}
	return &Daemon{cfg: cfg, db: db, templates: map[string]Template{}}
}

func TestHealthDistingueNoArDeProntoParaImprimir(t *testing.T) {
	cases := []struct {
		name      string
		printers  map[string]PrinterProfile
		wantReady bool
	}{
		{
			name:      "instalação nova sem impressora",
			printers:  map[string]PrinterProfile{"kitchen": {Template: "kitchen-default", Status: true}},
			wantReady: false,
		},
		{
			name:      "loja com endereço preenchido",
			printers:  map[string]PrinterProfile{"kitchen": {Address: "192.168.0.9:9100", Status: true}},
			wantReady: true,
		},
		{
			name:      "endereço em branco é espaço em branco",
			printers:  map[string]PrinterProfile{"kitchen": {Address: "   ", Status: true}},
			wantReady: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// DB de verdade (memória): o health consulta a fila, e um Daemon
			// sem db não provaria nada do caminho real.
			daemon := newTestDaemon(t, Config{Printers: tc.printers})
			rec := httptest.NewRecorder()
			daemon.health(rec, httptest.NewRequest("GET", "/health", nil))

			var body struct {
				Status   string   `json:"status"`
				Printers []string `json:"printers"`
				Ready    bool     `json:"ready"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("resposta não é JSON: %v (%s)", err, rec.Body.String())
			}
			if body.Status != "ok" {
				t.Fatalf("status = %q", body.Status)
			}
			if body.Ready != tc.wantReady {
				t.Fatalf("ready = %v, quero %v (printers=%v)", body.Ready, tc.wantReady, body.Printers)
			}
		})
	}
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func TestLoadTemplatesUsaEmbedQuandoNaoHaDiretorio(t *testing.T) {
	daemon := &Daemon{cfg: Config{TemplatesDir: filepath.Join(t.TempDir(), "nao-existe")}}
	if err := daemon.loadTemplates(); err != nil {
		t.Fatalf("loadTemplates sem diretório: %v", err)
	}
	daemon.mu.RLock()
	defer daemon.mu.RUnlock()
	if len(daemon.templates) == 0 {
		t.Fatal("nenhum template embutido carregado: o serviço não imprimiria nada")
	}
	for _, id := range []string{"kitchen-default", "courier-default", "fiscal-default"} {
		if _, ok := daemon.templates[id]; !ok {
			t.Fatalf("template embutido %q ausente (%d carregados)", id, len(daemon.templates))
		}
	}
}

func TestLoadTemplatesArquivoDoClienteSobrepoeOEmbed(t *testing.T) {
	dir := t.TempDir()
	conteudo := `{"id":"kitchen-default","destination":"kitchen","columns":32,"header":["CUSTOM"]}`
	if err := os.WriteFile(filepath.Join(dir, "kitchen-default.json"), []byte(conteudo), 0o644); err != nil {
		t.Fatal(err)
	}
	daemon := &Daemon{cfg: Config{TemplatesDir: dir}}
	if err := daemon.loadTemplates(); err != nil {
		t.Fatalf("loadTemplates: %v", err)
	}
	daemon.mu.RLock()
	defer daemon.mu.RUnlock()
	if got := daemon.templates["kitchen-default"]; got.Columns != 32 {
		t.Fatalf("columns = %d, quero 32 (o do cliente)", got.Columns)
	}
	// os outros embutidos continuam disponíveis
	if _, ok := daemon.templates["courier-default"]; !ok {
		t.Fatal("template embutido foi perdido ao carregar o do cliente")
	}
}
