package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Config struct {
	APIToken       string                    `json:"api_token"`
	Listen         string                    `json:"listen"`
	DataDir        string                    `json:"data_dir"`
	TemplatesDir   string                    `json:"templates_dir"`
	AllowedOrigins []string                  `json:"allowed_origins"`
	Printers       map[string]PrinterProfile `json:"printers"`
	Retry          RetryConfig               `json:"retry"`
	StatusMonitor  StatusMonitorConfig       `json:"status_monitor"`
	Cloud          CloudConfig               `json:"cloud"`
}

type RetryConfig struct {
	MaxAttempts      int `json:"max_attempts"`
	BaseDelaySecs    int `json:"base_delay_seconds"`
	MaxDelaySecs     int `json:"max_delay_seconds"`
	PollIntervalSecs int `json:"poll_interval_seconds"`
}

type StatusMonitorConfig struct {
	Enabled        bool `json:"enabled"`
	IntervalSecs   int  `json:"interval_seconds"`
	StaleAfterSecs int  `json:"stale_after_seconds"`
}

type PrinterProfile struct {
	Transport   string `json:"transport,omitempty"`
	PrinterID   string `json:"printer_id,omitempty"`
	PrinterName string `json:"printer_name,omitempty"`
	Address     string `json:"address"`
	Template    string `json:"template"`
	Status      bool   `json:"status"`
}

type PrinterStatus struct {
	Destination string          `json:"destination"`
	PrinterID   string          `json:"printer_id,omitempty"`
	Transport   string          `json:"transport,omitempty"`
	PrinterName string          `json:"printer_name,omitempty"`
	Address     string          `json:"address"`
	State       string          `json:"state"`
	Reachable   bool            `json:"reachable"`
	Supported   bool            `json:"status_supported"`
	Ready       bool            `json:"ready"`
	Paper       string          `json:"paper"`
	CoverOpen   bool            `json:"cover_open"`
	Offline     bool            `json:"offline"`
	Error       bool            `json:"error"`
	CutterError bool            `json:"cutter_error"`
	Raw         map[string]byte `json:"raw"`
	Message     string          `json:"message,omitempty"`
	CheckedAt   string          `json:"checked_at"`
	StateSince  string          `json:"state_since,omitempty"`
	Stale       bool            `json:"stale"`
	StatusAge   int             `json:"status_age_seconds"`
	Failures    int             `json:"consecutive_failures"`
}

type Template struct {
	ID          string  `json:"id"`
	Version     int     `json:"version"`
	Destination string  `json:"destination"`
	Columns     int     `json:"columns"`
	Blocks      []Block `json:"blocks"`
}

type Block struct {
	Type  string `json:"type"`
	Value string `json:"value,omitempty"`
	Align string `json:"align,omitempty"`
	Bold  bool   `json:"bold,omitempty"`
	Size  string `json:"size,omitempty"`
	Lines int    `json:"lines,omitempty"`
}

type Item struct {
	Name           string   `json:"name"`
	Quantity       int      `json:"quantity"`
	UnitPriceCents int64    `json:"unit_price_cents"`
	Notes          string   `json:"notes"`
	Addons         []string `json:"addons"`
}

type Order struct {
	Number     string `json:"number"`
	CreatedAt  string `json:"created_at"`
	Type       string `json:"type"`
	Notes      string `json:"notes"`
	Items      []Item `json:"items"`
	TotalCents int64  `json:"total_cents"`
	Customer   struct {
		Name  string `json:"name"`
		Phone string `json:"phone"`
	} `json:"customer"`
	Delivery struct {
		Address      string `json:"address"`
		Number       string `json:"number"`
		Complement   string `json:"complement"`
		Neighborhood string `json:"neighborhood"`
		Reference    string `json:"reference"`
	} `json:"delivery"`
	Payment struct {
		Method      string `json:"method"`
		ChangeCents int64  `json:"change_cents"`
	} `json:"payment"`
	Fiscal struct {
		Company   string `json:"company"`
		CNPJ      string `json:"cnpj"`
		AccessKey string `json:"access_key"`
		QRCodeURL string `json:"qr_code_url"`
	} `json:"fiscal"`
}

type PrintRequest struct {
	JobID       string `json:"job_id"`
	OrderID     string `json:"order_id"`
	Destination string `json:"destination"`
	Order       Order  `json:"order"`
}

type Daemon struct {
	cfg          Config
	db           *sql.DB
	templates    map[string]Template
	mu           sync.RWMutex
	printerMu    sync.Mutex
	printerLocks map[string]*sync.Mutex
	healthMu     sync.RWMutex
	healthCache  map[string]PrinterStatus
}

func main() {
	configPath := resolveConfigPath(os.Args[1:])
	cfg, err := ensureConfig(configPath)
	if err != nil {
		log.Fatal(err)
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8080"
	}
	// Caminho relativo é resolvido a partir de onde está o config.json: o
	// serviço do Windows roda com CWD em System32, então "./data" cairia em
	// C:\Windows\System32\data e a fila de impressão morria no primeiro
	// restart. Um caminho absoluto no config continua valendo.
	baseDir := filepath.Dir(mustAbs(configPath))
	cfg.DataDir = resolveDir(cfg.DataDir, baseDir, "data")
	cfg.TemplatesDir = resolveDir(cfg.TemplatesDir, baseDir, "templates")
	if cfg.Retry.MaxAttempts <= 0 {
		cfg.Retry.MaxAttempts = 8
	}
	if cfg.Retry.BaseDelaySecs <= 0 {
		cfg.Retry.BaseDelaySecs = 2
	}
	if cfg.Retry.MaxDelaySecs <= 0 {
		cfg.Retry.MaxDelaySecs = 120
	}
	if cfg.Retry.PollIntervalSecs <= 0 {
		cfg.Retry.PollIntervalSecs = 2
	}
	if cfg.StatusMonitor.IntervalSecs <= 0 {
		cfg.StatusMonitor.IntervalSecs = 5
	}
	if cfg.StatusMonitor.StaleAfterSecs <= 0 {
		cfg.StatusMonitor.StaleAfterSecs = cfg.StatusMonitor.IntervalSecs * 3
	}
	if err := os.MkdirAll(cfg.DataDir, 0750); err != nil {
		log.Fatal(err)
	}

	db, err := sql.Open("sqlite", filepath.Join(cfg.DataDir, "print_queue.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := migrate(db); err != nil {
		log.Fatal(err)
	}

	daemon := &Daemon{cfg: cfg, db: db, templates: map[string]Template{}, healthCache: map[string]PrinterStatus{}}
	if err := daemon.loadTemplates(); err != nil {
		log.Fatal(err)
	}
	go daemon.retryWorker()
	go daemon.statusMonitor()
	daemon.startCloudWorker()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", daemon.health)
	mux.HandleFunc("/api/templates", daemon.listTemplates)
	mux.HandleFunc("/api/jobs", daemon.listJobs)
	mux.HandleFunc("/api/printers/status", daemon.printerStatus)
	mux.HandleFunc("/api/print", daemon.print)
	mux.HandleFunc("/api/jobs/retry", daemon.retry)
	// API versionada; as rotas antigas permanecem para compatibilidade.
	mux.HandleFunc("/api/v1/templates", daemon.listTemplates)
	mux.HandleFunc("/api/v1/jobs", daemon.listJobs)
	mux.HandleFunc("/api/v1/printers/status", daemon.printerStatus)
	mux.HandleFunc("/api/v1/printers/discover", daemon.discoverPrinters)
	mux.HandleFunc("/api/v1/print", daemon.print)
	mux.HandleFunc("/api/v1/jobs/retry", daemon.retry)

	server := &http.Server{
		Addr: cfg.Listen, Handler: withCORS(mux, allowedOrigins(cfg)),
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	log.Printf("PDV printer daemon em %s; templates=%s", cfg.Listen, cfg.TemplatesDir)
	log.Fatal(server.ListenAndServe())
}

// defaultConfig é o ponto de partida de uma instalação nova. As impressoras
// vêm sem endereço de propósito: `status` falso e address vazio fazem o
// /health dizer "sem impressora configurada" em vez de mandar para um
// endereço herdado de outra loja.
func defaultConfig() Config {
	return Config{
		Listen: "127.0.0.1:8080",
		AllowedOrigins: []string{
			"tauri://localhost",
			"http://tauri.localhost",
			"http://localhost:1420",
		},
		Retry: RetryConfig{
			MaxAttempts:      8,
			BaseDelaySecs:    2,
			MaxDelaySecs:     120,
			PollIntervalSecs: 2,
		},
		Printers: map[string]PrinterProfile{
			"kitchen": {Template: "kitchen-default", Status: true},
			"courier": {Template: "courier-default", Status: true},
			"fiscal":  {Template: "fiscal-default", Status: true},
		},
	}
}

// ensureConfig carrega o config.json e, se ele não existir, cria um padrão.
// O instalador só precisa apontar o serviço para o caminho: quem escreve o
// arquivo é o próprio daemon, que é o lugar onde a estrutura do arquivo é
// conhecida. Se não der para criar (sem permissão, disco cheio), o daemon
// segue com o padrão em memória — imprimir continua funcionando, só não
// sobrevive a um restart até alguém criar o arquivo.
func ensureConfig(path string) (Config, error) {
	cfg, err := loadConfig(path)
	if err == nil {
		return cfg, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		// os.IsNotExist não olha dentro de %w; aqui o erro vem envelopado por
		// loadConfig e o daemon morreria num primeiro start.
		return Config{}, err
	}
	log.Printf("config %s inexistente; criando padrão", path)
	if writeErr := writeDefaultConfig(path); writeErr != nil {
		log.Printf("aviso: não consegui criar %s (%v); usando padrão em memória", path, writeErr)
	}
	return defaultConfig(), nil
}

func writeDefaultConfig(path string) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0750); err != nil {
			return err
		}
	}
	content, err := json.MarshalIndent(defaultConfig(), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0640)
}

func mustAbs(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

func resolveDir(value, baseDir, fallback string) string {
	if value == "" {
		value = filepath.Join(".", fallback)
	}
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	// No Windows filepath.IsAbs só aceita letra de drive ou UNC (volumeNameLen),
	// mas "\fila" e "/fila" também são absolutos para quem opera o serviço: são
	// a raiz da unidade corrente. Sem esta checagem eles caíam no Join de
	// baixo e o daemon lia/gravava em %ProgramData%\PDV Printer\fila em vez de
	// C:\fila — silenciosamente, porque o diretório errado é criado sem erro.
	//
	// Só no Windows: no Unix "/" já foi tratado pelo IsAbs acima e "\" é um
	// caractere válido de nome de arquivo, não raiz. Devolvido sem Clean de
	// propósito, porque o Clean do Windows troca "/" por "\" e reescreveria a
	// string que o operador escreveu no config.
	if runtime.GOOS == "windows" && (strings.HasPrefix(value, "/") || strings.HasPrefix(value, `\`)) {
		return value
	}
	return filepath.Join(baseDir, value)
}

// defaultConfigPath é onde o serviço do Windows procura o config quando não
// recebe --config: %ProgramData% é o único lugar que sobrevive a
// reinstalar o app e a atualizar o Windows. O instalador não precisa passar
// nada por linha de comando — o que evita a aspa escapada que o sc.exe
// exige quando o binPath carrega argumentos.
func defaultConfigPath() string {
	if dir := os.Getenv("ProgramData"); dir != "" {
		return filepath.Join(dir, "PDV Printer", "config.json")
	}
	return "config.json"
}

// resolveConfigPath decide de onde sai o config.json. Ordem: flag explícita
// (útil para teste e instalação manual) > PDV_PRINTER_CONFIG > primeiro
// argumento solto > %ProgramData%\PDV Printer\config.json.
func resolveConfigPath(args []string) string {
	path := ""
	for i, arg := range args {
		switch {
		case arg == "--config" || arg == "-c":
			if i+1 < len(args) {
				return args[i+1]
			}
		case strings.HasPrefix(arg, "--config="):
			return strings.TrimPrefix(arg, "--config=")
		case !strings.HasPrefix(arg, "-") && path == "":
			path = arg
		}
	}
	if path == "" {
		path = "config.json"
	}
	if value := os.Getenv("PDV_PRINTER_CONFIG"); value != "" && path == "config.json" {
		return value
	}
	if path == "config.json" {
		return defaultConfigPath()
	}
	return path
}

func loadConfig(path string) (Config, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("ler configuração %s: %w", path, err)
	}
	var cfg Config
	if err := json.Unmarshal(content, &cfg); err != nil {
		return Config{}, fmt.Errorf("configuração inválida: %w", err)
	}
	return cfg, nil
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS print_jobs (
	        id TEXT PRIMARY KEY, order_id TEXT NOT NULL, destination TEXT NOT NULL,
	        printer_id TEXT, payload_json TEXT NOT NULL, template_id TEXT NOT NULL, template_version INTEGER NOT NULL,
	        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
	        next_attempt_at TEXT, blocked_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
	        UNIQUE(order_id, destination)
	    )`)
	if err != nil {
		return err
	}
	// Migrações para bancos criados por versões anteriores do daemon.
	_, _ = db.Exec(`ALTER TABLE print_jobs ADD COLUMN next_attempt_at TEXT`)
	_, _ = db.Exec(`ALTER TABLE print_jobs ADD COLUMN payload_hash TEXT`)
	_, _ = db.Exec(`ALTER TABLE print_jobs ADD COLUMN printer_id TEXT`)
	_, _ = db.Exec(`ALTER TABLE print_jobs ADD COLUMN blocked_reason TEXT`)
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS external_events (
		external_event_id TEXT NOT NULL,
		destination TEXT NOT NULL,
		job_id TEXT,
		status TEXT NOT NULL,
		error TEXT,
		received_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (external_event_id, destination)
	)`)
	if err != nil {
		return err
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS cloud_state (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	if err != nil {
		return err
	}
	return nil
}

//go:embed templates/*.json
var embeddedTemplates embed.FS

// loadTemplates parte dos templates embutidos no binário e deixa o arquivo do
// cliente sobrepor por id. Antes o daemon dependia de um diretório de
// templates instalado ao lado: se ele sumisse (instalação pela metade, update
// do app, antivírus limpando pasta), o serviço não subia e o PDV ficava sem
// impressão. Com o embutido, o baseline sempre existe.
func (d *Daemon) loadTemplates() error {
	loaded := map[string]Template{}
	entries, err := embeddedTemplates.ReadDir("templates")
	if err != nil {
		return fmt.Errorf("ler templates embutidos: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		content, err := embeddedTemplates.ReadFile("templates/" + entry.Name())
		if err != nil {
			return err
		}
		template, err := parseTemplate(entry.Name(), content)
		if err != nil {
			return err
		}
		loaded[template.ID] = template
	}

	custom, err := os.ReadDir(d.cfg.TemplatesDir)
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("ler templates: %w", err)
		}
		d.mu.Lock()
		d.templates = loaded
		d.mu.Unlock()
		return nil
	}
	for _, entry := range custom {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(d.cfg.TemplatesDir, entry.Name()))
		if err != nil {
			return err
		}
		template, err := parseTemplate(entry.Name(), content)
		if err != nil {
			return err
		}
		loaded[template.ID] = template
	}
	d.mu.Lock()
	d.templates = loaded
	d.mu.Unlock()
	return nil
}

func parseTemplate(name string, content []byte) (Template, error) {
	var template Template
	if err := json.Unmarshal(content, &template); err != nil {
		return Template{}, fmt.Errorf("template %s inválido: %w", name, err)
	}
	if template.ID == "" || template.Destination == "" {
		return Template{}, fmt.Errorf("template %s sem id/destination", name)
	}
	if template.Columns == 0 {
		template.Columns = 48
	}
	return template, nil
}

func (d *Daemon) health(w http.ResponseWriter, r *http.Request) {
	// "no ar" e "pronto para imprimir" são coisas diferentes: numa instalação
	// nova o daemon sobe sem nenhuma impressora configurada e, se o health só
	// disser "ok", o gerente só descobre que a bobina não sai quando a
	// comanda chega. `printers` fica vazio nesse estado.
	configured := make([]string, 0, len(d.cfg.Printers))
	for name, profile := range d.cfg.Printers {
		if profileConfigured(profile) {
			configured = append(configured, name)
		}
	}
	sort.Strings(configured)
	writeJSON(w, 200, map[string]any{
		"status":        "ok",
		"printers":      configured,
		"ready":         len(configured) > 0,
		"templates":     len(d.templates),
		"queue_depth":   d.queueDepth(),
		"blocked_depth": d.blockedDepth(),
	})
}

// queueDepth é o tamanho da fila de impressão. Um número alto e crescendo é o
// sinal de que a impressora está offline há tempo demais.
func (d *Daemon) queueDepth() int {
	if d.db == nil {
		return 0
	}
	var total int
	if err := d.db.QueryRow(`SELECT COUNT(*) FROM print_jobs WHERE status IN ('queued','printing','retry_waiting','blocked_printer')`).Scan(&total); err != nil {
		return 0
	}
	return total
}

func (d *Daemon) blockedDepth() int {
	if d.db == nil {
		return 0
	}
	var total int
	if err := d.db.QueryRow(`SELECT COUNT(*) FROM print_jobs WHERE status='blocked_printer'`).Scan(&total); err != nil {
		return 0
	}
	return total
}

func (d *Daemon) listTemplates(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	result := make([]Template, 0, len(d.templates))
	for _, t := range d.templates {
		result = append(result, t)
	}
	writeJSON(w, 200, result)
}

func (d *Daemon) listJobs(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	rows, err := d.db.Query(`SELECT id, order_id, destination, COALESCE(printer_id,''), status, attempts, COALESCE(last_error,''), COALESCE(blocked_reason,''), COALESCE(next_attempt_at,''), created_at, updated_at FROM print_jobs ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	defer rows.Close()
	jobs := []map[string]any{}
	for rows.Next() {
		var id, orderID, destination, printerID, status, lastError, blockedReason, nextAttemptAt, createdAt, updatedAt string
		var attempts int
		if err := rows.Scan(&id, &orderID, &destination, &printerID, &status, &attempts, &lastError, &blockedReason, &nextAttemptAt, &createdAt, &updatedAt); err != nil {
			writeError(w, 500, err)
			return
		}
		jobs = append(jobs, map[string]any{"id": id, "order_id": orderID, "destination": destination, "printer_id": printerID, "status": status, "attempts": attempts, "last_error": lastError, "blocked_reason": blockedReason, "next_attempt_at": nextAttemptAt, "created_at": createdAt, "updated_at": updatedAt})
	}
	writeJSON(w, 200, jobs)
}

func (d *Daemon) printerStatus(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}
	destination := r.URL.Query().Get("destination")
	if destination != "" {
		if _, ok := d.cfg.Printers[destination]; !ok {
			writeError(w, http.StatusNotFound, fmt.Errorf("destino não configurado: %s", destination))
			return
		}
		writeJSON(w, http.StatusOK, d.queryPrinterStatus(destination))
		return
	}

	statuses := make([]PrinterStatus, 0, len(d.cfg.Printers))
	for destination := range d.cfg.Printers {
		statuses = append(statuses, d.queryPrinterStatus(destination))
	}
	writeJSON(w, http.StatusOK, map[string]any{"printers": statuses})
}

func (d *Daemon) discoverPrinters(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}
	printers, err := discoverPlatformPrinters()
	if err != nil {
		writeError(w, http.StatusNotImplemented, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"printers": printers})
}

func (d *Daemon) probePrinterStatus(destination string) PrinterStatus {
	profile := d.cfg.Printers[destination]
	status := PrinterStatus{
		Destination: destination,
		Transport:   profile.Transport,
		PrinterName: profile.PrinterName,
		Address:     profile.Address,
		Paper:       "unknown",
		Raw:         map[string]byte{},
		CheckedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if !profile.Status {
		status.Message = "consulta DLE EOT desabilitada no perfil"
		return status
	}

	transport, err := transportFor(profile)
	if err != nil {
		status.Message = err.Error()
		return status
	}
	for n := byte(1); n <= 4; n++ {
		value, err := transport.Query(context.Background(), n)
		if err != nil {
			if n == 1 {
				status.Message = err.Error()
			}
			continue
		}
		status.Reachable = true
		status.Supported = true
		status.Raw[fmt.Sprintf("n%d", n)] = value
		applyStatusBits(&status, n, value)
	}
	status.Ready = status.Reachable && status.Supported && !status.Offline && !status.Error && !status.CoverOpen && status.Paper == "ok"
	if !status.Reachable && status.Message == "" {
		status.Message = "sem resposta ao DLE EOT"
	}
	return status
}

func queryDLEEOT(address string, n byte) (byte, error) {
	return queryDLEEOTContext(context.Background(), address, n)
}

func queryDLEEOTContext(ctx context.Context, address string, n byte) (byte, error) {
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return 0, fmt.Errorf("impressora inacessível: %w", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return 0, err
	}
	if _, err := conn.Write([]byte{0x10, 0x04, n}); err != nil {
		return 0, fmt.Errorf("enviar DLE EOT %d: %w", n, err)
	}
	var response [1]byte
	if _, err := io.ReadFull(conn, response[:]); err != nil {
		return 0, fmt.Errorf("ler resposta DLE EOT %d: %w", n, err)
	}
	return response[0], nil
}

// As máscaras abaixo seguem o mapa ESC/POS Epson/Bematech mais comum.
// A variante/firmware da MP-4200 deve ser validada em bancada; Raw sempre
// é retornado para permitir ajustar a interpretação sem perder o diagnóstico.
func applyStatusBits(status *PrinterStatus, n, value byte) {
	switch n {
	case 1:
		status.Offline = value&0x08 != 0
		status.Error = status.Error || value&0x20 != 0
	case 2:
		status.CoverOpen = value&0x04 != 0
	case 3:
		status.CutterError = value&0x04 != 0
		status.Error = status.Error || value&0x08 != 0
	case 4:
		if value&0x60 != 0 {
			status.Paper = "out"
		} else if value&0x0c != 0 {
			status.Paper = "near_end"
		} else {
			status.Paper = "ok"
		}
	}
}

func (d *Daemon) print(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, 405, errors.New("método não permitido"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)
	var req PrintRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, fmt.Errorf("JSON inválido: %w", err))
		return
	}
	if req.JobID == "" {
		req.JobID = fmt.Sprintf("job-%d", time.Now().UnixNano())
	}
	if err := validatePrintRequest(req); err != nil {
		writeError(w, 400, err)
		return
	}
	profile, ok := d.cfg.Printers[req.Destination]
	if !ok || !profileConfigured(profile) {
		writeError(w, 400, fmt.Errorf("nenhuma impressora configurada para %s", req.Destination))
		return
	}
	template, err := d.templateFor(profile.Template, req.Destination)
	if err != nil {
		writeError(w, 400, err)
		return
	}
	payload, _ := json.Marshal(req)
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	status, existingID, err := d.enqueue(req, template, payload, hash)
	if err != nil {
		if errors.Is(err, errIdempotencyConflict) {
			writeError(w, http.StatusConflict, err)
		} else {
			writeError(w, 500, err)
		}
		return
	}
	if existingID != "" {
		writeJSON(w, 200, map[string]any{"job_id": existingID, "status": status, "idempotent": true})
		return
	}
	if err := d.process(req.JobID); err != nil {
		writeJSON(w, 202, map[string]any{"job_id": req.JobID, "status": d.jobStatus(req.JobID), "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"job_id": req.JobID, "status": "sent_to_printer"})
}

func (d *Daemon) retry(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, 405, errors.New("método não permitido"))
		return
	}
	var body struct {
		JobID string `json:"job_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.JobID == "" {
		writeError(w, 400, errors.New("job_id é obrigatório"))
		return
	}
	_, _ = d.db.Exec(`UPDATE print_jobs SET status='queued', attempts=0, next_attempt_at=NULL, last_error='', updated_at=? WHERE id=?`, time.Now().UTC().Format(time.RFC3339), body.JobID)
	if err := d.process(body.JobID); err != nil {
		writeError(w, 502, err)
		return
	}
	writeJSON(w, 200, map[string]any{"job_id": body.JobID, "status": "sent_to_printer"})
}

var errIdempotencyConflict = errors.New("o mesmo pedido e destino já possuem outro conteúdo pendente")

func (d *Daemon) authorize(w http.ResponseWriter, r *http.Request) bool {
	if d.cfg.APIToken == "" {
		return true
	}
	value := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if value == "" || subtle.ConstantTimeCompare([]byte(value), []byte(d.cfg.APIToken)) != 1 {
		writeError(w, http.StatusUnauthorized, errors.New("token da API ausente ou inválido"))
		return false
	}
	return true
}

func validatePrintRequest(req PrintRequest) error {
	if strings.TrimSpace(req.JobID) == "" || strings.TrimSpace(req.OrderID) == "" || strings.TrimSpace(req.Destination) == "" {
		return errors.New("job_id, order_id e destination são obrigatórios")
	}
	if len(req.JobID) > 160 || len(req.OrderID) > 160 || len(req.Destination) > 80 {
		return errors.New("job_id, order_id e destination excedem o tamanho máximo")
	}
	if len(req.Order.Items) > 500 {
		return errors.New("o pedido excede o limite de 500 itens")
	}
	for i, item := range req.Order.Items {
		if strings.TrimSpace(item.Name) == "" {
			return fmt.Errorf("item %d sem nome", i+1)
		}
		if item.Quantity <= 0 || item.Quantity > 10000 {
			return fmt.Errorf("quantidade inválida no item %d", i+1)
		}
		if item.UnitPriceCents < 0 {
			return fmt.Errorf("preço inválido no item %d", i+1)
		}
	}
	return nil
}

func profileConfigured(profile PrinterProfile) bool {
	transport := strings.ToLower(strings.TrimSpace(profile.Transport))
	if transport == "" || transport == "tcp" || transport == "tcp9100" {
		return strings.TrimSpace(profile.Address) != ""
	}
	if transport == "windows_spooler" || transport == "winspool" || transport == "spooler" {
		return strings.TrimSpace(profile.PrinterName) != ""
	}
	if transport == "cups" || transport == "cups_raw" || transport == "ipp" {
		return strings.TrimSpace(profile.PrinterName) != ""
	}
	return strings.TrimSpace(profile.PrinterID) != "" || strings.TrimSpace(profile.Address) != ""
}

func (d *Daemon) enqueue(req PrintRequest, template Template, payload []byte, hash string) (status, existingID string, err error) {
	var oldID, oldPayload, oldHash, oldStatus string
	queryErr := d.db.QueryRow(`SELECT id, payload_json, COALESCE(payload_hash,''), status FROM print_jobs WHERE order_id=? AND destination=?`, req.OrderID, req.Destination).Scan(&oldID, &oldPayload, &oldHash, &oldStatus)
	if queryErr == nil {
		if oldHash == "" {
			oldHash = fmt.Sprintf("%x", sha256.Sum256([]byte(oldPayload)))
		}
		if oldHash != hash {
			return "", "", fmt.Errorf("%w: job_id existente=%s", errIdempotencyConflict, oldID)
		}
		return oldStatus, oldID, nil
	}
	if !errors.Is(queryErr, sql.ErrNoRows) {
		return "", "", queryErr
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = d.db.Exec(`INSERT INTO print_jobs (id, order_id, destination, payload_json, payload_hash, template_id, template_version, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?)`, req.JobID, req.OrderID, req.Destination, payload, hash, template.ID, template.Version, now, now)
	return "queued", "", err
}

func (d *Daemon) lockPrinter(profile PrinterProfile, destination string) func() {
	key := strings.TrimSpace(profile.PrinterID)
	if key == "" {
		transport := profile.Transport
		if transport == "" {
			transport = "tcp"
		}
		target := profile.Address
		if target == "" {
			target = profile.PrinterName
		}
		key = transport + ":" + target
	}
	if key == ":" {
		key = "destination:" + destination
	}
	d.printerMu.Lock()
	if d.printerLocks == nil {
		d.printerLocks = map[string]*sync.Mutex{}
	}
	lock := d.printerLocks[key]
	if lock == nil {
		lock = &sync.Mutex{}
		d.printerLocks[key] = lock
	}
	d.printerMu.Unlock()
	lock.Lock()
	return lock.Unlock
}

func (d *Daemon) process(jobID string) error {
	var orderID, destination, payload, templateID, currentStatus string
	var templateVersion, attempts int
	err := d.db.QueryRow(`SELECT order_id, destination, payload_json, template_id, template_version, attempts, status FROM print_jobs WHERE id=?`, jobID).Scan(&orderID, &destination, &payload, &templateID, &templateVersion, &attempts, &currentStatus)
	if err != nil {
		return err
	}
	if currentStatus != "queued" && currentStatus != "retry_waiting" {
		return nil
	}
	_ = orderID
	_ = templateVersion
	var req PrintRequest
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		d.finishJob(jobID, "failed", err)
		return err
	}
	template, err := d.templateFor(templateID, destination)
	if err != nil {
		d.finishJob(jobID, "failed", err)
		return err
	}
	profile := d.cfg.Printers[destination]
	unlock := d.lockPrinter(profile, destination)
	defer unlock()
	transport, err := transportFor(profile)
	if err != nil {
		d.finishJob(jobID, "failed", err)
		return err
	}
	attempts++
	_, _ = d.db.Exec(`UPDATE print_jobs SET status='printing', attempts=?, next_attempt_at=NULL, updated_at=? WHERE id=?`, attempts, time.Now().UTC().Format(time.RFC3339), jobID)
	buffer, err := render(template, req.Order)
	if err == nil {
		err = transport.Send(context.Background(), buffer)
	}
	if err == nil {
		d.finishJob(jobID, "sent_to_printer", nil)
		return nil
	}

	if isRetryablePrinterError(err) && attempts < d.cfg.Retry.MaxAttempts {
		delay := d.retryDelay(attempts)
		next := time.Now().UTC().Add(delay).Format(time.RFC3339)
		_, _ = d.db.Exec(`UPDATE print_jobs SET status='retry_waiting', last_error=?, next_attempt_at=?, updated_at=? WHERE id=?`, err.Error(), next, time.Now().UTC().Format(time.RFC3339), jobID)
		log.Printf("job %s aguardando retry em %s: %v", jobID, next, err)
		return err
	}

	// Falhas de escrita podem ocorrer depois que parte dos bytes foi enviada.
	// Não repetir automaticamente nesse caso: o operador deve confirmar.
	status := "unknown"
	if !isRetryablePrinterError(err) || attempts >= d.cfg.Retry.MaxAttempts {
		status = "reprint_confirmation"
	}
	d.finishJob(jobID, status, err)
	return err
}

func (d *Daemon) retryWorker() {
	d.processDueJobs()
	ticker := time.NewTicker(time.Duration(d.cfg.Retry.PollIntervalSecs) * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		d.processDueJobs()
	}
}

func (d *Daemon) processDueJobs() {
	now := time.Now().UTC().Format(time.RFC3339)
	rows, err := d.db.Query(`SELECT id FROM print_jobs WHERE attempts < ? AND (status='queued' OR (status='retry_waiting' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))) ORDER BY created_at LIMIT 20`, d.cfg.Retry.MaxAttempts, now)
	if err != nil {
		log.Printf("consultar fila de retry: %v", err)
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	_ = rows.Close()
	for _, id := range ids {
		if err := d.process(id); err != nil {
			log.Printf("processar job %s: %v", id, err)
		}
	}
}

func (d *Daemon) retryDelay(attempt int) time.Duration {
	seconds := d.cfg.Retry.BaseDelaySecs
	for i := 1; i < attempt; i++ {
		seconds *= 2
		if seconds >= d.cfg.Retry.MaxDelaySecs {
			seconds = d.cfg.Retry.MaxDelaySecs
			break
		}
	}
	if seconds > d.cfg.Retry.MaxDelaySecs {
		seconds = d.cfg.Retry.MaxDelaySecs
	}
	return time.Duration(seconds) * time.Second
}

func isRetryablePrinterError(err error) bool {
	if err == nil {
		return false
	}
	// Apenas falhas ao abrir a conexão são repetidas automaticamente.
	// Falha de escrita pode significar que parte do cupom já foi recebida.
	return strings.HasPrefix(err.Error(), "conectar à impressora:")
}

func (d *Daemon) finishJob(jobID, status string, err error) {
	errorText := ""
	if err != nil {
		errorText = err.Error()
	}
	_, _ = d.db.Exec(`UPDATE print_jobs SET status=?, last_error=?, next_attempt_at=NULL, updated_at=? WHERE id=?`, status, errorText, time.Now().UTC().Format(time.RFC3339), jobID)
}

func (d *Daemon) jobStatus(jobID string) string {
	var status string
	if err := d.db.QueryRow(`SELECT status FROM print_jobs WHERE id=?`, jobID).Scan(&status); err != nil {
		return "unknown"
	}
	return status
}

func (d *Daemon) templateFor(id, destination string) (Template, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if id == "" {
		for _, t := range d.templates {
			if t.Destination == destination {
				return t, nil
			}
		}
	}
	t, ok := d.templates[id]
	if !ok || t.Destination != destination {
		return Template{}, fmt.Errorf("template não encontrado: %s/%s", id, destination)
	}
	return t, nil
}

func sendTCP(address string, buffer []byte) error {
	return sendTCPContext(context.Background(), address, buffer)
}

func sendTCPContext(ctx context.Context, address string, buffer []byte) error {
	dialer := net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return fmt.Errorf("conectar à impressora: %w", err)
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write(buffer); err != nil {
		return fmt.Errorf("enviar ESC/POS: %w", err)
	}
	return nil
}

func render(t Template, order Order) ([]byte, error) {
	b := &escpos{}
	b.init()
	for _, block := range t.Blocks {
		switch block.Type {
		case "text":
			b.align(block.Align)
			b.bold(block.Bold)
			b.size(block.Size)
			b.line(expand(block.Value, order))
			b.size("")
			b.bold(false)
		case "separator":
			b.align("left")
			b.line(strings.Repeat("-", t.Columns))
		case "items":
			b.align("left")
			for _, item := range order.Items {
				b.bold(true)
				b.line(fmt.Sprintf("%dx %s", item.Quantity, item.Name))
				b.bold(false)
				for _, addon := range item.Addons {
					b.line("  + " + addon)
				}
				if item.Notes != "" {
					b.line("  OBS: " + item.Notes)
				}
			}
		case "notes":
			if order.Notes != "" {
				b.bold(true)
				b.line("OBSERVAÇÕES")
				b.bold(false)
				b.line(order.Notes)
			}
		case "customer":
			b.bold(true)
			b.line("CLIENTE")
			b.bold(false)
			b.line(order.Customer.Name)
			b.line("Telefone: " + order.Customer.Phone)
		case "delivery":
			b.bold(true)
			b.line("ENDEREÇO")
			b.bold(false)
			b.line(order.Delivery.Address + ", " + order.Delivery.Number)
			if order.Delivery.Complement != "" {
				b.line("Complemento: " + order.Delivery.Complement)
			}
			if order.Delivery.Neighborhood != "" {
				b.line("Bairro: " + order.Delivery.Neighborhood)
			}
			if order.Delivery.Reference != "" {
				b.line("Referência: " + order.Delivery.Reference)
			}
		case "payment":
			b.line("Pagamento: " + order.Payment.Method)
			if order.Payment.ChangeCents > 0 {
				b.line("Troco: " + money(order.Payment.ChangeCents))
			}
		case "total":
			b.align("right")
			b.bold(true)
			b.line("TOTAL: " + money(order.TotalCents))
			b.bold(false)
		case "qrcode":
			b.align("center")
			addQRCode(b, expand(block.Value, order))
		case "feed":
			b.feed(block.Lines)
		case "cut":
			b.cut()
		default:
			return nil, fmt.Errorf("bloco desconhecido: %s", block.Type)
		}
	}
	return b.bytes(), nil
}

func expand(value string, o Order) string {
	replacements := map[string]string{"{{order.number}}": o.Number, "{{order.created_at}}": o.CreatedAt, "{{order.type}}": strings.ToUpper(o.Type), "{{order.notes}}": o.Notes, "{{fiscal.company}}": o.Fiscal.Company, "{{fiscal.cnpj}}": o.Fiscal.CNPJ, "{{fiscal.access_key}}": o.Fiscal.AccessKey, "{{fiscal.qr_code_url}}": o.Fiscal.QRCodeURL}
	for k, v := range replacements {
		value = strings.ReplaceAll(value, k, v)
	}
	return value
}
func money(c int64) string { return fmt.Sprintf("R$ %d,%02d", c/100, c%100) }

type escpos struct{ data []byte }

func (e *escpos) init()         { e.data = append(e.data, 0x1b, 0x40) }
func (e *escpos) line(s string) { e.data = append(e.data, []byte(s+"\n")...) }
func (e *escpos) align(a string) {
	v := byte(0)
	if a == "center" {
		v = 1
	}
	if a == "right" {
		v = 2
	}
	e.data = append(e.data, 0x1b, 0x61, v)
}
func (e *escpos) bold(on bool) {
	v := byte(0)
	if on {
		v = 1
	}
	e.data = append(e.data, 0x1b, 0x45, v)
}
func (e *escpos) size(s string) {
	if s == "double" {
		e.data = append(e.data, 0x1d, 0x21, 0x11)
	} else {
		e.data = append(e.data, 0x1d, 0x21, 0x00)
	}
}
func (e *escpos) feed(n int) {
	for i := 0; i < n; i++ {
		e.data = append(e.data, '\n')
	}
}
func (e *escpos) cut()          { e.data = append(e.data, 0x1d, 0x56, 0x42, 0x00) }
func (e *escpos) bytes() []byte { return e.data }
func addQRCode(e *escpos, value string) {
	if value == "" {
		return
	}
	data := []byte(value)
	size := len(data) + 3
	e.data = append(e.data, 0x1d, 0x28, 0x6b, 4, 0, 49, 65, 50, 0)
	e.data = append(e.data, 0x1d, 0x28, 0x6b, 3, 0, 49, 67, 4)
	e.data = append(e.data, 0x1d, 0x28, 0x6b, 3, 0, 49, 69, 48)
	e.data = append(e.data, 0x1d, 0x28, 0x6b, byte(size), byte(size>>8), 49, 80, 48)
	e.data = append(e.data, data...)
	e.data = append(e.data, 0x1d, 0x28, 0x6b, 3, 0, 49, 81, 48)
	e.feed(1)
}

// Origens do app Tauri. O WebView2 do Windows reporta `http://tauri.localhost`
// e o macOS/Linux `tauri://localhost`; sem elas o daemon responde sem o
// cabeçalho de CORS e o app não consegue imprimir de dentro do Tauri. Vão
// sempre, independentemente do config do cliente: qualquer site aberto no
// navegador não consegue forjar essas origens, então não se perde nada.
var builtinOrigins = []string{
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
}

func allowedOrigins(cfg Config) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(builtinOrigins)+len(cfg.AllowedOrigins))
	for _, origin := range append(append([]string{}, builtinOrigins...), cfg.AllowedOrigins...) {
		if origin == "" || seen[origin] {
			continue
		}
		seen[origin] = true
		out = append(out, origin)
	}
	return out
}

func withCORS(next http.Handler, origins []string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		for _, allowed := range origins {
			if origin != "" && origin == allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
				break
			}
		}
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{"status": "error", "message": err.Error()})
}

var _ = context.Background
var _ = io.EOF
