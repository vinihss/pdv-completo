package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Config struct {
	Listen         string                    `json:"listen"`
	DataDir        string                    `json:"data_dir"`
	TemplatesDir   string                    `json:"templates_dir"`
	AllowedOrigins []string                  `json:"allowed_origins"`
	Printers       map[string]PrinterProfile `json:"printers"`
	Retry          RetryConfig               `json:"retry"`
}

type RetryConfig struct {
	MaxAttempts      int `json:"max_attempts"`
	BaseDelaySecs    int `json:"base_delay_seconds"`
	MaxDelaySecs     int `json:"max_delay_seconds"`
	PollIntervalSecs int `json:"poll_interval_seconds"`
}

type PrinterProfile struct {
	Address  string `json:"address"`
	Template string `json:"template"`
	Status   bool   `json:"status"`
}

type PrinterStatus struct {
	Destination string          `json:"destination"`
	Address     string          `json:"address"`
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
	cfg       Config
	db        *sql.DB
	templates map[string]Template
	mu        sync.RWMutex
	processMu sync.Mutex
}

func main() {
	configPath := "config.json"
	if value := os.Getenv("PDV_PRINTER_CONFIG"); value != "" {
		configPath = value
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatal(err)
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8080"
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "./data"
	}
	if cfg.TemplatesDir == "" {
		cfg.TemplatesDir = "./templates"
	}
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

	daemon := &Daemon{cfg: cfg, db: db, templates: map[string]Template{}}
	if err := daemon.loadTemplates(); err != nil {
		log.Fatal(err)
	}
	go daemon.retryWorker()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", daemon.health)
	mux.HandleFunc("/api/templates", daemon.listTemplates)
	mux.HandleFunc("/api/jobs", daemon.listJobs)
	mux.HandleFunc("/api/printers/status", daemon.printerStatus)
	mux.HandleFunc("/api/print", daemon.print)
	mux.HandleFunc("/api/jobs/retry", daemon.retry)

	server := &http.Server{
		Addr: cfg.Listen, Handler: withCORS(mux, cfg.AllowedOrigins),
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	log.Printf("PDV printer daemon em %s; templates=%s", cfg.Listen, cfg.TemplatesDir)
	log.Fatal(server.ListenAndServe())
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
	        payload_json TEXT NOT NULL, template_id TEXT NOT NULL, template_version INTEGER NOT NULL,
	        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
	        next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
	        UNIQUE(order_id, destination)
	    )`)
	if err != nil {
		return err
	}
	// Migração para bancos criados por versões anteriores do daemon.
	_, _ = db.Exec(`ALTER TABLE print_jobs ADD COLUMN next_attempt_at TEXT`)
	return nil
}

func (d *Daemon) loadTemplates() error {
	entries, err := os.ReadDir(d.cfg.TemplatesDir)
	if err != nil {
		return fmt.Errorf("ler templates: %w", err)
	}
	loaded := map[string]Template{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(d.cfg.TemplatesDir, entry.Name()))
		if err != nil {
			return err
		}
		var template Template
		if err := json.Unmarshal(content, &template); err != nil {
			return fmt.Errorf("template %s inválido: %w", entry.Name(), err)
		}
		if template.ID == "" || template.Destination == "" {
			return fmt.Errorf("template %s sem id/destination", entry.Name())
		}
		if template.Columns == 0 {
			template.Columns = 48
		}
		loaded[template.ID] = template
	}
	d.mu.Lock()
	d.templates = loaded
	d.mu.Unlock()
	return nil
}

func (d *Daemon) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"status": "ok"})
}

func (d *Daemon) listTemplates(w http.ResponseWriter, r *http.Request) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	result := make([]Template, 0, len(d.templates))
	for _, t := range d.templates {
		result = append(result, t)
	}
	writeJSON(w, 200, result)
}

func (d *Daemon) listJobs(w http.ResponseWriter, r *http.Request) {
	rows, err := d.db.Query(`SELECT id, order_id, destination, status, attempts, COALESCE(last_error,''), COALESCE(next_attempt_at,''), created_at, updated_at FROM print_jobs ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	defer rows.Close()
	jobs := []map[string]any{}
	for rows.Next() {
		var id, orderID, destination, status, lastError, nextAttemptAt, createdAt, updatedAt string
		var attempts int
		if err := rows.Scan(&id, &orderID, &destination, &status, &attempts, &lastError, &nextAttemptAt, &createdAt, &updatedAt); err != nil {
			writeError(w, 500, err)
			return
		}
		jobs = append(jobs, map[string]any{"id": id, "order_id": orderID, "destination": destination, "status": status, "attempts": attempts, "last_error": lastError, "next_attempt_at": nextAttemptAt, "created_at": createdAt, "updated_at": updatedAt})
	}
	writeJSON(w, 200, jobs)
}

func (d *Daemon) printerStatus(w http.ResponseWriter, r *http.Request) {
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

func (d *Daemon) queryPrinterStatus(destination string) PrinterStatus {
	profile := d.cfg.Printers[destination]
	status := PrinterStatus{
		Destination: destination,
		Address:     profile.Address,
		Paper:       "unknown",
		Raw:         map[string]byte{},
		CheckedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if !profile.Status {
		status.Message = "consulta DLE EOT desabilitada no perfil"
		return status
	}

	for n := byte(1); n <= 4; n++ {
		value, err := queryDLEEOT(profile.Address, n)
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
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.Dial("tcp", address)
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
	if req.OrderID == "" || req.Destination == "" {
		writeError(w, 400, errors.New("order_id e destination são obrigatórios"))
		return
	}
	profile, ok := d.cfg.Printers[req.Destination]
	if !ok || profile.Address == "" {
		writeError(w, 400, fmt.Errorf("nenhuma impressora configurada para %s", req.Destination))
		return
	}
	template, err := d.templateFor(profile.Template, req.Destination)
	if err != nil {
		writeError(w, 400, err)
		return
	}
	payload, _ := json.Marshal(req)
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = d.db.Exec(`INSERT INTO print_jobs (id, order_id, destination, payload_json, template_id, template_version, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?) ON CONFLICT(order_id, destination) DO UPDATE SET payload_json=excluded.payload_json, template_id=excluded.template_id, template_version=excluded.template_version, status='queued', attempts=0, next_attempt_at=NULL, last_error='', updated_at=excluded.updated_at`, req.JobID, req.OrderID, req.Destination, payload, template.ID, template.Version, now, now)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	if err := d.process(req.JobID); err != nil {
		writeJSON(w, 202, map[string]any{"job_id": req.JobID, "status": d.jobStatus(req.JobID), "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"job_id": req.JobID, "status": "sent_to_printer"})
}

func (d *Daemon) retry(w http.ResponseWriter, r *http.Request) {
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

func (d *Daemon) process(jobID string) error {
	d.processMu.Lock()
	defer d.processMu.Unlock()

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
	attempts++
	_, _ = d.db.Exec(`UPDATE print_jobs SET status='printing', attempts=?, next_attempt_at=NULL, updated_at=? WHERE id=?`, attempts, time.Now().UTC().Format(time.RFC3339), jobID)
	buffer, err := render(template, req.Order)
	if err == nil {
		err = sendTCP(profile.Address, buffer)
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
	dialer := net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.Dial("tcp", address)
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

func withCORS(next http.Handler, allowedOrigins []string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		for _, allowed := range allowedOrigins {
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
