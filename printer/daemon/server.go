package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Este arquivo é a superfície do daemon: o transporte TCP cru, a sondagem de
// status da impressora e a API HTTP local. Duas decisões moldam quase tudo aqui.
//
// A API é exposta ao navegador (Tauri, PWA) e o bind padrão é 127.0.0.1, o que
// não impede uma página aberta em qualquer site de alcançar a porta. Por isso o
// controle real é duplo: token (authorize) e origem (withCORS). O CORS sozinho
// não bastaria — POST text/plain é requisição "simples" e dispensa preflight, e
// o navegador enviaria o pedido de verdade; só o 403 ativo do withCORS impede
// que um site imprima no restaurante do cliente.
//
// O segundo cuidado: "não consegui perguntar o status" não é "sem papel". O
// spooler do Windows e o CUPS não expõem DLE EOT (ADR-09, risco R6), e tratar a
// recusa da consulta como sensor negativo bloquearia a fila de uma impressora
// perfeitamente saudável.

const (
	// defaultPrinterPort é a porta RAW do JetDirect: o config do técnico
	// quase sempre traz só o IP, e sem esta porta o dial falharia com um erro
	// confuso de "no such host".
	defaultPrinterPort = "9100"

	dialTimeout    = 5 * time.Second
	writeTimeout   = 5 * time.Second
	statusTimeout  = 2 * time.Second
	probeTimeout   = 5 * time.Second
	shutdownGrace  = 5 * time.Second
	maxPrintBody   = 512 * 1024
	defaultJobList = 50
	maxJobList     = 500
)

// normalizePrinterAddress completa a porta RAW quando o config traz só o
// endereço. SplitHostPort é o teste certo (e não um Contains(":")), senão um
// IPv6 sem porta como fe80::1 seria tratado como "já tem porta".
func normalizePrinterAddress(address string) string {
	address = strings.TrimSpace(address)
	if address == "" {
		return address
	}
	if _, _, err := net.SplitHostPort(address); err == nil {
		return address
	}
	return net.JoinHostPort(address, defaultPrinterPort)
}

// sendTCPContext escreve o cupom ESC/POS na impressora de rede.
//
// O dialing respeita o contexto: um job cancelado (shutdown, reenvio) não pode
// abrir conexão nova. Falha de dialing é marcada como transitória porque
// nenhum byte saiu — é o único tipo de falha que o retryWorker repete com
// segurança (ADR-05). Falha de escrita NÃO é marcada: a impressora pode já ter
// impresso metade do cupom, e repetir duplicaria o papel. O operador é quem
// decide nesse caso (reprint_confirmation).
func sendTCPContext(ctx context.Context, address string, data []byte) error {
	if len(data) == 0 {
		return errors.New("documento ESC/POS vazio")
	}
	target := normalizePrinterAddress(address)
	dialer := net.Dialer{Timeout: dialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", target)
	if err != nil {
		return markTransient(fmt.Errorf("conectar à impressora %s: %w", target, err))
	}
	defer conn.Close()

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(writeTimeout)
	}
	_ = conn.SetWriteDeadline(deadline)
	if _, err := conn.Write(data); err != nil {
		return fmt.Errorf("enviar ESC/POS para %s: %w", target, err)
	}
	return nil
}

// queryDLEEOTContext pergunta um dos quatro sensores ESC/POS (DLE EOT n) e lê
// um byte de resposta.
//
// Só o transporte TCP implementa: CUPS e o spooler do Windows não expõem os
// sensores e recusam a consulta por contrato (ver os Query deles). O deadline
// curto é o que impede que uma impressora desligada trave a API — o
// /api/printers/status responde mesmo com a impressora fora.
func queryDLEEOTContext(ctx context.Context, address string, n byte) (byte, error) {
	if n < 1 || n > 4 {
		return 0, fmt.Errorf("consulta DLE EOT fora da faixa: %d", n)
	}
	target := normalizePrinterAddress(address)
	dialer := net.Dialer{Timeout: statusTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", target)
	if err != nil {
		return 0, fmt.Errorf("impressora inacessível: %w", err)
	}
	defer conn.Close()

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(statusTimeout)
	}
	if remaining := time.Until(deadline); remaining < statusTimeout {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(statusTimeout))
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

// applyStatusBits decodifica um byte de DLE EOT. As máscaras são do mapa
// ESC/POS Epson/Bematech mais comum e precisam ser validadas em bancada por
// modelo; o byte bruto vai sempre em status.Raw para dar diagnóstico sem
// perder a leitura original.
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
		switch {
		case value&0x60 != 0:
			status.Paper = "out"
		case value&0x0c != 0:
			status.Paper = "near_end"
		default:
			status.Paper = "ok"
		}
	}
}

// probePrinterStatus pergunta a impressora e monta o PrinterStatus do destino.
//
// Três saídas distintas, e confundi-las é o bug que o risco R6 descreve:
//   - respondeu: Supported=true, Paper vem do sensor (n=4).
//   - não respondeu mas o transporte é TCP: Supported=false e o alcance vem de
//     um dial puro. Fica "unknown", nunca "sem papel".
//   - não expõe DLE EOT (CUPS, spooler): Supported=false, alcançável, e
//     Paper continua "unknown" — nunca "out".
func (d *Daemon) probePrinterStatus(destination string) PrinterStatus {
	profile := d.cfg.Printers[destination]
	kind := strings.TrimSpace(profile.Transport)
	if kind == "" {
		kind = "tcp"
	}
	status := PrinterStatus{
		Destination: destination,
		PrinterID:   d.physicalPrinterID(profile, destination),
		Transport:   kind,
		PrinterName: profile.PrinterName,
		Address:     profile.Address,
		Paper:       "unknown",
		Raw:         map[string]byte{},
		CheckedAt:   time.Now().UTC().Format(time.RFC3339),
	}

	if !profileConfigured(profile) {
		status.State = PrinterStateUnknown
		status.Message = "nenhuma impressora configurada para este destino"
		return status
	}
	if !profile.Status {
		// O técnico desligou a sondagem deste destino. Reportar "sem papel"
		// aqui bloquearia a fila de uma impressora que ninguém monitora.
		status.Reachable = true
		status.Supported = false
		status.State = PrinterStateUnknown
		status.Message = "consulta de status desabilitada no perfil"
		return status
	}

	transport, err := transportFor(profile)
	if err != nil {
		status.State = PrinterStateOffline
		status.Message = err.Error()
		return status
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	asked := 0
	for n := byte(1); n <= 4; n++ {
		value, err := transport.Query(ctx, n)
		if err != nil {
			// A primeira falha é a que explica o resto: normalmente a
			// impressora não respondeu nada.
			if asked == 0 {
				status.Message = err.Error()
			}
			continue
		}
		asked++
		status.Reachable = true
		status.Supported = true
		status.Raw[fmt.Sprintf("n%d", n)] = value
		applyStatusBits(&status, n, value)
	}

	if !status.Supported {
		// Nenhum sensor respondeu. Não pode virar "sem papel" (R6): o estado
		// fica desconhecido e o alcançamento, quando dá para probar, vem de um
		// dial simples na porta 9100.
		status.Paper = "unknown"
		if address := strings.TrimSpace(profile.Address); address != "" {
			status.Reachable = dialReachable(address)
		} else {
			// Fila local (CUPS/spooler): a impressora é do próprio host, e
			// declarar offline aqui bloquearia tudo sem evidência.
			status.Reachable = true
		}
		status.Message = "impressora não expõe o status ESC/POS (DLE EOT)"
	}

	status.Ready = status.Reachable && status.Supported && !status.Offline &&
		!status.Error && !status.CoverOpen && status.Paper == "ok"
	status.State = derivePrinterState(status)
	return status
}

// dialReachable responde "a porta 9100 aceita conexão?" sem enviar nada: é o
// único sinal disponível quando os sensores DLE EOT não existem.
func dialReachable(address string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), statusTimeout)
	defer cancel()
	dialer := net.Dialer{Timeout: statusTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", normalizePrinterAddress(address))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// -------------------------------------------------------------------------
// Segurança
// -------------------------------------------------------------------------

// builtinOrigins são as origens do app desktop. O WebView2 do Windows reporta
// http://tauri.localhost e o macOS/Linux tauri://localhost; sem elas o app não
// consegue imprimir de dentro do Tauri. Vão sempre, independentemente do
// config do cliente: um site aberto no navegador não consegue forjar uma origem
// dessas, então liberá-las não abre nada.
var builtinOrigins = []string{
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
}

// allowedOrigins junta as origens embutidas com as do config, sem repetir: o
// técnico pode (e vai) colar uma origem que já vem por padrão.
func allowedOrigins(cfg Config) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(builtinOrigins)+len(cfg.AllowedOrigins))
	for _, origin := range append(append([]string{}, builtinOrigins...), cfg.AllowedOrigins...) {
		origin = strings.TrimSpace(origin)
		if origin == "" || seen[origin] {
			continue
		}
		seen[origin] = true
		out = append(out, origin)
	}
	return out
}

// withCORS aplica a política de origem.
//
// Não é só cabeçalhos: origem desconhecida é recusada com 403 e o handler não
// é chamado. O ancestral (a4817e1) só omitia o Access-Control-Allow-Origin, o
// que bloqueia a leitura da resposta no navegador mas NÃO impede o efeito — um
// POST text/plain é "simples", dispensa preflight, e a página vizinha
// imprimiria no restaurante com o token que... não tem. Ainda assim, exigir o
// token impede o printing acidental e o 403 impede o resto do estrago de um
// endpoint frouxo futuro.
//
// Pedido sem Origin (curl, Tauri/Rust, service worker do app) segue normal: não
// existe navegador para proteger nesse caso.
func withCORS(next http.Handler, origins []string) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, origin := range origins {
		if origin != "" {
			allowed[origin] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		permitted := origin == "" || allowed[origin]

		w.Header().Add("Vary", "Origin")
		if permitted && origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}

		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			if !permitted {
				writeError(w, http.StatusForbidden, errors.New("origem não permitida"))
				return
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			// Exato, e com Authorization: sem ele no preflight o navegador
			// bloqueia todo cliente que use token, que é o caso dos três.
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Max-Age", "600")
			// O daemon é alcançado em rede local (http://127.0.0.1:8080) e o
			// Chrome pergunta pela rede privada nos preflights.
			if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if !permitted {
			writeError(w, http.StatusForbidden, errors.New("origem não permitida"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authorize é um guard, não middleware: cada handler chama no topo e devolve o
// corpo quando false. Config sem api_token é modo de compatibilidade (daemon
// antigo sem token no config) e passa tudo — com aviso no log, porque é o
// estado perigoso e silencioso.
//
// A comparação é em tempo constante para não vazar o token por tempo.
func (d *Daemon) authorize(w http.ResponseWriter, r *http.Request) bool {
	expected := strings.TrimSpace(d.cfg.APIToken)
	if expected == "" {
		expected = strings.TrimSpace(os.Getenv("PDV_API_TOKEN"))
	}
	if expected == "" {
		return true
	}

	header := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	token := ""
	if strings.HasPrefix(header, prefix) {
		token = strings.TrimSpace(strings.TrimPrefix(header, prefix))
	}
	if subtleCompare(token, expected) {
		return true
	}
	writeError(w, http.StatusUnauthorized, errors.New("token ausente ou inválido"))
	return false
}

// subtleCompare compara sem sair no primeiro byte diferente (crypto/subtle).
func subtleCompare(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// -------------------------------------------------------------------------
// Helpers de resposta
// -------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError devolve {status, message}: o frontend mostra a mensagem do daemon
// quando ela existe (daemonRequest), então ela precisa ser de utilidade para o
// operador, não um código.
func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{"status": "error", "message": err.Error()})
}

// queueDepth é o tamanho da fila. Um número alto e subindo é o sinal de que a
// impressora está offline há tempo demais. Daemon sem banco (literal de valor
// zero nos testes) devolve 0 em vez de estourar.
func (d *Daemon) queueDepth() int {
	if d.db == nil {
		return 0
	}
	var total int
	if err := d.db.QueryRow(`SELECT COUNT(*) FROM print_jobs WHERE status IN ('queued','printing','retry_waiting')`).Scan(&total); err != nil {
		return 0
	}
	return total
}

// -------------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------------

// health é o único endpoint sem token: é o que o instalador e o
// print.routes.ts consultam para saber se o serviço subiu, e não expõe nada
// além da existência de destinos configurados.
//
// "no ar" e "pronto para imprimir" são coisas diferentes. Numa instalação nova
// o daemon sobe sem nenhuma impressora configurada; se o health só dissesse
// "ok", o gerente só descobriria que a bobina não sai quando a comanda chega.
func (d *Daemon) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}
	configured := d.configuredDestinations()
	d.mu.RLock()
	templates := len(d.templates)
	d.mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{
		// "ok" e nunca "online": os três clientes comparam esse texto.
		"status":      "ok",
		"printers":    configured,
		"ready":       len(configured) > 0,
		"templates":   templates,
		"queue_depth": d.queueDepth(),
	})
}

// configuredDestinations lista os destinos com impressora de fato configurada,
// em ordem alfabética: o técnico compara a saída do health com o config.json
// linha a linha.
func (d *Daemon) configuredDestinations() []string {
	configured := make([]string, 0, len(d.cfg.Printers))
	for name, profile := range d.cfg.Printers {
		if profileConfigured(profile) {
			configured = append(configured, name)
		}
	}
	sort.Strings(configured)
	return configured
}

// print recebe o pedido e devolve 202 com o job enfileirado.
//
// A resposta é 202 e não 200 porque o daemon assume a responsabilidade do
// papel: o cliente precisa saber que o trabalho foi aceito e persistido, e o
// resultado da impressão chega por /api/jobs e pelo status da impressora.
//
// A ordem aqui é a segurança da fila: valida tudo (pedido, destino, template)
// ANTES de gravar. Destino sem template é erro permanente — enfileirar um job
// que nunca vai imprimir só acumula papel perdido na fila.
func (d *Daemon) print(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxPrintBody)
	var req PrintRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("JSON inválido: %w", err))
		return
	}
	// O id é do cliente (order_id-destination) porque a fila deduplica por
	// (order_id, destination); sem ele, cairia num id com data e a reimpressão
	// viraria job duplicado.
	if strings.TrimSpace(req.JobID) == "" {
		req.JobID = fmt.Sprintf("job-%d", time.Now().UnixNano())
	}
	if err := validatePrintRequest(req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	profile, ok := d.cfg.Printers[req.Destination]
	if !ok || !profileConfigured(profile) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("nenhuma impressora configurada para %s", req.Destination))
		return
	}
	template, err := d.templateFor(profile.Template, req.Destination)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	payload, err := json.Marshal(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serializar pedido: %w", err))
		return
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))

	if _, _, err := d.enqueue(req, template, payload, hash); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// O status vem do banco, não da intenção: um reenvio do mesmo pedido pode
	// reenfileirar um job que já imprimiu, e "queued" seria mentira.
	status := d.jobStatus(req.JobID)
	if status == "" {
		status = "queued"
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"job_id": req.JobID, "status": status})
}

// jobView é a linha de print_jobs exposta em /api/jobs. As tags são o contrato
// com DaemonJob no printer.client.ts.
type jobView struct {
	ID            string `json:"id"`
	OrderID       string `json:"order_id"`
	Destination   string `json:"destination"`
	PrinterID     string `json:"printer_id"`
	Status        string `json:"status"`
	Attempts      int    `json:"attempts"`
	LastError     string `json:"last_error"`
	NextAttemptAt string `json:"next_attempt_at"`
	BlockedReason string `json:"blocked_reason"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

// listJobs devolve a fila para o painel do operador. A resposta é um array puro
// porque é o que os dois clientes fazem direto: printerClient.getJobs() e o
// getPrintStatus do frontend chamam .filter() no resultado sem desembrulhar
// envelope.
func (d *Daemon) listJobs(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}
	if d.db == nil {
		writeJSON(w, http.StatusOK, []jobView{})
		return
	}

	limit := defaultJobList
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	// Teto: a fila é consultada por painel e por polling; sem teto, um ?limit
	// enorme traria a fila inteira e estouraria o WriteTimeout.
	if limit > maxJobList {
		limit = maxJobList
	}

	rows, err := d.db.Query(`SELECT id, order_id, destination, COALESCE(printer_id,''), status, attempts,
		COALESCE(last_error,''), COALESCE(next_attempt_at,''), COALESCE(blocked_reason,''), created_at, updated_at
		FROM print_jobs ORDER BY created_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	jobs := make([]jobView, 0, limit)
	for rows.Next() {
		var job jobView
		if err := rows.Scan(&job.ID, &job.OrderID, &job.Destination, &job.PrinterID, &job.Status,
			&job.Attempts, &job.LastError, &job.NextAttemptAt, &job.BlockedReason,
			&job.CreatedAt, &job.UpdatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, jobs)
}

// retry é o escape do operador: devolve um job preso (reprint_confirmation,
// blocked_printer, failed) para a fila, com as tentativas zeradas.
//
// Não devolve erro quando a impressão falha de novo — o job fica em
// retry_waiting e o retryWorker assume. A resposta 200 diz "reenfileirado", e
// quem imprime é a fila, não o request.
func (d *Daemon) retry(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}
	var body struct {
		JobID string `json:"job_id"`
		ID    string `json:"id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("JSON inválido: %w", err))
		return
	}
	jobID := strings.TrimSpace(body.JobID)
	if jobID == "" {
		jobID = strings.TrimSpace(body.ID)
	}
	if jobID == "" {
		writeError(w, http.StatusBadRequest, errors.New("job_id é obrigatório"))
		return
	}
	if d.db == nil {
		writeError(w, http.StatusInternalServerError, errors.New("fila indisponível"))
		return
	}

	var exists int
	if err := d.db.QueryRow(`SELECT COUNT(*) FROM print_jobs WHERE id=?`, jobID).Scan(&exists); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if exists == 0 {
		writeError(w, http.StatusNotFound, fmt.Errorf("job não encontrado: %s", jobID))
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.db.Exec(`UPDATE print_jobs SET status='queued', attempts=0, next_attempt_at=NULL, last_error='', blocked_reason=NULL, updated_at=? WHERE id=?`, now, jobID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// Processamento fora do request: um cupom de fiscal leva segundos para
	// renderizar e enviar, e segurar o handler aqui estouraria o WriteTimeout
	// de 10s sem dar nenhuma informação a mais ao operador.
	go func() {
		if err := d.process(jobID); err != nil {
			log.Printf("retry manual do job %s: %v", jobID, err)
		}
	}()

	writeJSON(w, http.StatusOK, map[string]any{"job_id": jobID, "status": "queued"})
}

// printerStatus devolve o PrinterStatus de um destino ou de todos.
//
// Usa queryPrinterStatus (não probePrinterStatus) para o endpoint HTTP: o cache
// do monitor evita abrir quatro conexões por consulta, e o polls do frontend é
// bem mais frequente que o intervalo do monitor.
func (d *Daemon) printerStatus(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}

	if destination := strings.TrimSpace(r.URL.Query().Get("destination")); destination != "" {
		if _, ok := d.cfg.Printers[destination]; !ok {
			writeError(w, http.StatusNotFound, fmt.Errorf("destino não configurado: %s", destination))
			return
		}
		writeJSON(w, http.StatusOK, d.queryPrinterStatus(destination))
		return
	}

	destinations := make([]string, 0, len(d.cfg.Printers))
	for destination := range d.cfg.Printers {
		destinations = append(destinations, destination)
	}
	sort.Strings(destinations)

	statuses := make([]PrinterStatus, 0, len(destinations))
	for _, destination := range destinations {
		statuses = append(statuses, d.queryPrinterStatus(destination))
	}
	writeJSON(w, http.StatusOK, map[string]any{"printers": statuses})
}

// listTemplates é a lista de layouts disponíveis, sem os blocos: o técnico
// precisa do id e da largura para escolher o que joga em templates_dir, e
// mandar os blocos só aumentaria a resposta sem uso.
func (d *Daemon) listTemplates(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}

	d.mu.RLock()
	list := make([]map[string]any, 0, len(d.templates))
	for _, template := range d.templates {
		list = append(list, map[string]any{
			"id":          template.ID,
			"version":     template.Version,
			"destination": template.Destination,
			"columns":     template.Columns,
		})
	}
	d.mu.RUnlock()

	sort.Slice(list, func(i, j int) bool {
		return list[i]["id"].(string) < list[j]["id"].(string)
	})
	writeJSON(w, http.StatusOK, map[string]any{"templates": list})
}

// discoverPrinters lista as impressoras que a plataforma enxerga (EnumPrintersW
// no Windows, lpstat no Linux). Fora dessas plataformas é 501: o técnico sabe
// qual é a impressora da loja, e varrer a sub-rede foi rejeitado (ADR-12).
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
	if printers == nil {
		printers = []DiscoveredPrinter{}
	}
	writeJSON(w, http.StatusOK, printers)
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

// runDaemon monta e serve o daemon. Devolve erro em vez de log.Fatal porque o
// serviço do Windows precisa que o processo termine com código diferente de
// zero para o SCM aplicar a ação de recuperação (service_windows.go:44).
func runDaemon(ctx context.Context) error {
	configPath := resolveConfigPath(os.Args[1:])
	cfg, err := ensureConfig(configPath)
	if err != nil {
		return err
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8080"
	}

	// Caminho relativo é resolvido a partir de onde está o config.json: o
	// serviço do Windows roda com CWD em System32, então "./data" cairia em
	// C:\Windows\System32\data e a fila de impressão morria no primeiro
	// restart. Um caminho absoluto escrito no config continua valendo.
	baseDir := filepath.Dir(mustAbs(configPath))
	cfg.DataDir = resolveDir(cfg.DataDir, baseDir, "data")
	cfg.TemplatesDir = resolveDir(cfg.TemplatesDir, baseDir, "templates")

	cfg.Retry = normalizeRetry(cfg.Retry)
	// Normalizar o monitor aqui e não em loadConfig é deliberado: os dois
	// valores alimentam time.NewTicker direto (monitor.go:47) e um intervalo 0
	// ou negativo derruba o processo — mas um default mesclado no loadConfig
	// sobrescreveria o que o técnico configurou, que é a armadilha que
	// ensureConfig existe para evitar.
	cfg.StatusMonitor.IntervalSecs = positiveOr(cfg.StatusMonitor.IntervalSecs, 30)
	cfg.StatusMonitor.StaleAfterSecs = positiveOr(cfg.StatusMonitor.StaleAfterSecs, 120)

	if err := os.MkdirAll(cfg.DataDir, 0750); err != nil {
		return fmt.Errorf("criar diretório de dados: %w", err)
	}

	db, err := sql.Open("sqlite", filepath.Join(cfg.DataDir, "print_queue.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	// Uma conexão só: o SQLite não gosta de dois escritores e reportPendingStatuses
	// segura as linhas antes de sair para HTTP (cloud.go:288-311) justamente
	// contando com essa serialização.
	db.SetMaxOpenConns(1)

	if err := migrate(db); err != nil {
		return err
	}

	daemon := &Daemon{cfg: cfg, db: db, templates: map[string]Template{}}
	if err := daemon.loadTemplates(); err != nil {
		// Fatal: sem template não há cupom, e subir assim só transformaria o
		// erro (template inválido) num sintoma de papel em branco.
		return fmt.Errorf("carregar templates: %w", err)
	}

	// Job que ficou em "printing" quando o processo caiu não pode ser
	// reimprimido sozinho: pode ter saído metade do cupom. Vira
	// reprint_confirmation e espera o operador.
	if recovered, err := daemon.recoverInterruptedJobs(); err != nil {
		log.Printf("recuperar jobs interrompidos: %v", err)
	} else if recovered > 0 {
		log.Printf("%d job(s) interrompido(s) voltaram para confirmação de reimpressão", recovered)
	}

	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		daemon.retryWorker(ctx)
	}()
	go daemon.statusMonitor()
	workers.Add(1)
	go func() {
		defer workers.Done()
		daemon.startCloudWorker(ctx)
	}()
	// TODO(Fase 3): worker de auto-update. Não ligado de propósito — o
	// updater.go atual grava o executável antes de comparar o SHA256 e sem
	// assinatura minisign (ADR-15), então ligá-lo agora publicaria um binário
	// não verificado na loja. A reescrita (baixar para arquivo temporário,
	// conferir hash e assinatura, só então aplicar) é o que vai ligá-lo.

	mux := http.NewServeMux()
	mux.HandleFunc("/health", daemon.health)
	mux.HandleFunc("/api/print", daemon.print)
	mux.HandleFunc("/api/jobs", daemon.listJobs)
	mux.HandleFunc("/api/jobs/retry", daemon.retry)
	mux.HandleFunc("/api/printers/status", daemon.printerStatus)
	mux.HandleFunc("/api/templates", daemon.listTemplates)
	mux.HandleFunc("/api/v1/printers/discover", daemon.discoverPrinters)

	server := &http.Server{
		Addr:    cfg.Listen,
		Handler: withCORS(mux, allowedOrigins(cfg)),
		// Os quatro timeouts não podem baixar: sem ReadHeaderTimeout um
		// cliente que abre a conexão e não manda cabeçalho segura uma goroutine
		// para sempre, e WriteTimeout curto cortaria a resposta de um job que
		// ainda está renderizando.
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	if strings.TrimSpace(cfg.APIToken) == "" {
		log.Printf("aviso: api_token vazio — a API fica sem autenticação (veja PDV_API_TOKEN)")
	}
	log.Printf("PDV printer daemon em %s; templates=%s; dados=%s", cfg.Listen, cfg.TemplatesDir, cfg.DataDir)

	serveErr := make(chan error, 1)
	go func() {
		err := server.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErr <- err
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	log.Printf("encerrando: draining das conexões")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	shutdownErr := server.Shutdown(shutdownCtx)

	// Os workers olham o ctx, então já estão voltando; esperar aqui evita
	// derrubar o banco (defer db.Close) no meio de uma consulta.
	finished := make(chan struct{})
	go func() {
		workers.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-shutdownCtx.Done():
		log.Printf("workers não terminaram em %s; encerrando mesmo assim", shutdownGrace)
	}
	return shutdownErr
}

func normalizeRetry(retry RetryConfig) RetryConfig {
	retry.MaxAttempts = positiveOr(retry.MaxAttempts, 8)
	retry.BaseDelaySecs = positiveOr(retry.BaseDelaySecs, 2)
	retry.MaxDelaySecs = positiveOr(retry.MaxDelaySecs, 120)
	retry.PollIntervalSecs = positiveOr(retry.PollIntervalSecs, 2)
	return retry
}

func positiveOr(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func main() {
	// Sob o SCM, quem roda o daemon é o dispatcher: ele já chamou runDaemon e
	// o processo termina junto com ele. Subir o servidor aqui em paralelo
	// brigaria pela mesma porta.
	if runAsWindowsService(runDaemon) {
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runDaemon(ctx); err != nil {
		log.Fatalf("daemon de impressão encerrou com erro: %v", err)
	}
}
