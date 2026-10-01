package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// CloudConfig define o contrato de saída do daemon para o backend da loja.
// O daemon nunca expõe uma porta pública para receber eventos: ele busca os
// eventos por uma conexão iniciada localmente.
type CloudConfig struct {
	Enabled            bool   `json:"enabled"`
	BaseURL            string `json:"base_url"`
	StationID          string `json:"station_id"`
	Token              string `json:"token"`
	EventsPath         string `json:"events_path"`
	AckPath            string `json:"ack_path"`
	StatusPath         string `json:"status_path"`
	PollIntervalSecs   int    `json:"poll_interval_seconds"`
	BatchSize          int    `json:"batch_size"`
	RequestTimeoutSecs int    `json:"request_timeout_seconds"`
}

type CloudEvent struct {
	ExternalEventID string       `json:"external_event_id"`
	Cursor          string       `json:"cursor,omitempty"`
	Print           PrintRequest `json:"print"`
}

type cloudPollResponse struct {
	Events     []CloudEvent `json:"events"`
	NextCursor string       `json:"next_cursor,omitempty"`
}

type cloudAck struct {
	StationID       string `json:"station_id"`
	ExternalEventID string `json:"external_event_id"`
	Destination     string `json:"destination"`
	JobID           string `json:"job_id"`
	Status          string `json:"status"`
	Error           string `json:"error,omitempty"`
}

// permanentEventError marca um evento que nunca será aceito, não importa
// quantas vezes seja reentregue (destino sem impressora, template inexistente,
// conflito de idempotência). Esses eventos são confirmados como "rejected";
// do contrário o cursor não avança e eles bloqueiam todos os eventos seguintes.
type permanentEventError struct{ err error }

func (e *permanentEventError) Error() string { return e.err.Error() }
func (e *permanentEventError) Unwrap() error { return e.err }

func permanentEvent(err error) error { return &permanentEventError{err: err} }

type cloudJobStatus struct {
	StationID       string `json:"station_id"`
	ExternalEventID string `json:"external_event_id"`
	JobID           string `json:"job_id"`
	Status          string `json:"status"`
	Error           string `json:"error,omitempty"`
}

func normalizeCloudConfig(cfg CloudConfig) CloudConfig {
	if cfg.EventsPath == "" {
		cfg.EventsPath = "/v1/print-events"
	}
	if cfg.AckPath == "" {
		cfg.AckPath = "/v1/print-events/{external_event_id}/ack"
	}
	if cfg.StatusPath == "" {
		cfg.StatusPath = "/v1/print-events/{external_event_id}/status"
	}
	if cfg.PollIntervalSecs <= 0 {
		cfg.PollIntervalSecs = 3
	}
	if cfg.BatchSize <= 0 || cfg.BatchSize > 100 {
		cfg.BatchSize = 20
	}
	if cfg.RequestTimeoutSecs <= 0 {
		cfg.RequestTimeoutSecs = 15
	}
	return cfg
}

func (d *Daemon) startCloudWorker(ctx context.Context) {
	cfg := normalizeCloudConfig(d.cfg.Cloud)
	if !cfg.Enabled {
		return
	}
	if strings.TrimSpace(cfg.Token) == "" {
		cfg.Token = strings.TrimSpace(os.Getenv("PDV_CLOUD_TOKEN"))
	}
	if err := validateCloudConfig(cfg); err != nil {
		log.Printf("impressão web automática desabilitada: %v", err)
		return
	}
	d.cfg.Cloud = cfg
	go d.cloudWorker(ctx)
}

func validateCloudConfig(cfg CloudConfig) error {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return errors.New("cloud.base_url não configurado")
	}
	base, err := url.Parse(cfg.BaseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return fmt.Errorf("cloud.base_url inválido: %q", cfg.BaseURL)
	}
	if base.Scheme != "https" && base.Hostname() != "localhost" && base.Hostname() != "127.0.0.1" {
		return errors.New("cloud.base_url deve usar HTTPS fora de localhost")
	}
	if strings.TrimSpace(cfg.StationID) == "" {
		return errors.New("cloud.station_id não configurado")
	}
	if strings.TrimSpace(cfg.Token) == "" {
		return errors.New("cloud.token não configurado")
	}
	return nil
}

func (d *Daemon) cloudWorker(ctx context.Context) {
	cfg := d.cfg.Cloud
	client := &http.Client{Timeout: time.Duration(cfg.RequestTimeoutSecs) * time.Second}

	// Faz uma busca logo no início para reduzir o tempo até a primeira
	// impressão depois que o serviço sobe.
	d.pollCloudOnce(ctx, client)
	d.reportPendingStatuses(ctx, client)

	ticker := time.NewTicker(time.Duration(cfg.PollIntervalSecs) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.pollCloudOnce(ctx, client)
			// Roda mesmo se o polling falhou: o resultado de jobs já aceitos
			// (inclusive os que imprimiram em retry) precisa chegar à nuvem.
			d.reportPendingStatuses(ctx, client)
		}
	}
}

func (d *Daemon) pollCloudOnce(ctx context.Context, client *http.Client) {
	cfg := d.cfg.Cloud
	cursor, err := d.cloudCursor()
	if err != nil {
		log.Printf("cloud: ler cursor: %v", err)
		return
	}

	endpoint, err := cloudEndpoint(cfg.BaseURL, cfg.EventsPath)
	if err != nil {
		log.Printf("cloud: endpoint de eventos: %v", err)
		return
	}
	query := endpoint.Query()
	query.Set("station_id", cfg.StationID)
	query.Set("limit", fmt.Sprintf("%d", cfg.BatchSize))
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	endpoint.RawQuery = query.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		log.Printf("cloud: criar request de polling: %v", err)
		return
	}
	d.setCloudHeaders(request)
	response, err := client.Do(request)
	if err != nil {
		log.Printf("cloud: polling station=%s: %v", cfg.StationID, err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
		log.Printf("cloud: polling HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
		return
	}

	var batch cloudPollResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(&batch); err != nil {
		log.Printf("cloud: resposta de polling inválida: %v", err)
		return
	}

	for _, event := range batch.Events {
		if err := d.handleCloudEvent(ctx, client, event); err != nil {
			log.Printf("cloud: evento %s: %v", event.ExternalEventID, err)
			// Não avança o cursor deste evento. O próximo polling poderá
			// reentregar o evento e a tabela de deduplicação impedirá duplicata.
			return
		}
		if event.Cursor != "" {
			if err := d.setCloudCursor(event.Cursor); err != nil {
				log.Printf("cloud: salvar cursor %q: %v", event.Cursor, err)
				return
			}
		}
	}
	if batch.NextCursor != "" && len(batch.Events) == 0 {
		if err := d.setCloudCursor(batch.NextCursor); err != nil {
			log.Printf("cloud: salvar cursor vazio: %v", err)
		}
	}
}

func (d *Daemon) handleCloudEvent(ctx context.Context, client *http.Client, event CloudEvent) error {
	if strings.TrimSpace(event.ExternalEventID) == "" {
		return errors.New("external_event_id ausente")
	}
	if event.Print.JobID == "" {
		event.Print.JobID = "cloud-" + event.ExternalEventID
	}
	if err := validatePrintRequest(event.Print); err != nil {
		return d.rejectCloudEvent(ctx, client, event, fmt.Errorf("pedido inválido: %w", err))
	}

	jobID, destination, duplicate, err := d.persistCloudEvent(event)
	if err != nil {
		var permanent *permanentEventError
		if errors.As(err, &permanent) {
			return d.rejectCloudEvent(ctx, client, event, err)
		}
		// Falha transitória (banco ocupado, disco): não avança o cursor; o
		// evento volta no próximo polling.
		return err
	}

	// O ACK confirma somente que o daemon recebeu e persistiu o trabalho
	// localmente. O status posterior (sent_to_printer, retry_waiting,
	// reprint_confirmation, failed) é reportado por reportPendingStatuses.
	if err := d.ackCloudEvent(ctx, client, event, jobID, "accepted", ""); err != nil {
		return err
	}

	if duplicate {
		log.Printf("cloud: evento deduplicado event=%s job=%s", event.ExternalEventID, jobID)
		return nil
	}

	go func() {
		if processErr := d.process(jobID); processErr != nil {
			log.Printf("cloud: job %s: %v", jobID, processErr)
		}
		d.reportPendingStatuses(context.Background(), client)
	}()

	log.Printf("cloud: evento aceito event=%s destination=%s job=%s", event.ExternalEventID, destination, jobID)
	return nil
}

// rejectCloudEvent registra e confirma a rejeição de um evento que nunca será
// impresso. Se o ACK falhar devolve erro, e o evento é reentregue.
func (d *Daemon) rejectCloudEvent(ctx context.Context, client *http.Client, event CloudEvent, cause error) error {
	_ = d.recordCloudEventFailure(event.ExternalEventID, cause.Error())
	log.Printf("cloud: evento %s rejeitado: %v", event.ExternalEventID, cause)
	if ackErr := d.ackCloudEvent(ctx, client, event, "", "rejected", cause.Error()); ackErr != nil {
		return fmt.Errorf("%v; confirmar rejeição: %w", cause, ackErr)
	}
	return nil
}

// reportPendingStatuses envia à nuvem o status atual de todo job aceito cujo
// status mudou desde o último relato. Ler do banco (e não de uma goroutine
// que imprime uma vez) cobre retries que imprimem depois, reimpressão manual,
// eventos reentregues e reinício do daemon.
func (d *Daemon) reportPendingStatuses(ctx context.Context, client *http.Client) {
	cfg := d.cfg.Cloud
	if strings.TrimSpace(cfg.StatusPath) == "" {
		return
	}
	d.reportMu.Lock()
	defer d.reportMu.Unlock()

	// O pool tem uma única conexão: lê tudo e fecha o cursor antes de fazer
	// HTTP ou outro Exec, senão o daemon trava.
	type pending struct{ eventID, destination, jobID, status, lastError string }
	rows, err := d.db.Query(`SELECT e.external_event_id, e.destination, j.id, j.status, COALESCE(j.last_error,'')
		FROM external_events e JOIN print_jobs j ON j.id = e.job_id
		WHERE e.status='accepted'
		  AND j.status IN ('retry_waiting','sent_to_printer','reprint_confirmation','failed','blocked_printer')
		  AND COALESCE(e.reported_status,'') <> j.status
		ORDER BY e.received_at LIMIT 50`)
	if err != nil {
		log.Printf("cloud: consultar status pendentes: %v", err)
		return
	}
	var list []pending
	for rows.Next() {
		var p pending
		if rows.Scan(&p.eventID, &p.destination, &p.jobID, &p.status, &p.lastError) == nil {
			list = append(list, p)
		}
	}
	_ = rows.Close()

	for _, p := range list {
		if ctx.Err() != nil {
			return
		}
		if err := d.reportCloudJobStatus(ctx, client, p.eventID, p.jobID, p.status, p.lastError); err != nil {
			log.Printf("cloud: reportar status event=%s job=%s: %v", p.eventID, p.jobID, err)
			return // nuvem indisponível; tenta de novo no próximo ciclo
		}
		_, _ = d.db.Exec(`UPDATE external_events SET reported_status=? WHERE external_event_id=? AND destination=?`, p.status, p.eventID, p.destination)
	}
}

func (d *Daemon) persistCloudEvent(event CloudEvent) (jobID, destination string, duplicate bool, err error) {
	req := event.Print
	profile, ok := d.cfg.Printers[req.Destination]
	if !ok || !profileConfigured(profile) {
		return "", req.Destination, false, permanentEvent(fmt.Errorf("nenhuma impressora configurada para %s", req.Destination))
	}
	template, err := d.templateFor(profile.Template, req.Destination)
	if err != nil {
		return "", req.Destination, false, permanentEvent(err)
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return "", req.Destination, false, err
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	now := time.Now().UTC().Format(time.RFC3339)

	tx, err := d.db.Begin()
	if err != nil {
		return "", req.Destination, false, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	result, err := tx.Exec(`INSERT INTO external_events (external_event_id, destination, job_id, status, received_at, updated_at) VALUES (?, ?, ?, 'received', ?, ?) ON CONFLICT(external_event_id, destination) DO NOTHING`, event.ExternalEventID, req.Destination, req.JobID, now, now)
	if err != nil {
		return "", req.Destination, false, err
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return "", req.Destination, false, err
	}
	if inserted == 0 {
		var existingJob string
		if scanErr := tx.QueryRow(`SELECT job_id FROM external_events WHERE external_event_id=? AND destination=?`, event.ExternalEventID, req.Destination).Scan(&existingJob); scanErr != nil {
			return "", req.Destination, false, scanErr
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return "", req.Destination, false, commitErr
		}
		return existingJob, req.Destination, true, nil
	}

	var existingID, oldPayload, oldHash string
	queryErr := tx.QueryRow(`SELECT id, payload_json, COALESCE(payload_hash,'') FROM print_jobs WHERE order_id=? AND destination=?`, req.OrderID, req.Destination).Scan(&existingID, &oldPayload, &oldHash)
	if queryErr == nil {
		if oldHash == "" {
			oldHash = fmt.Sprintf("%x", sha256.Sum256([]byte(oldPayload)))
		}
		if oldHash != hash {
			return "", req.Destination, false, permanentEvent(fmt.Errorf("%w: job_id existente=%s", errIdempotencyConflict, existingID))
		}
		jobID = existingID
	} else if errors.Is(queryErr, sql.ErrNoRows) {
		jobID = req.JobID
		printerID := d.physicalPrinterID(profile, req.Destination)
		_, err = tx.Exec(`INSERT INTO print_jobs (id, order_id, destination, printer_id, payload_json, payload_hash, template_id, template_version, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?)`, jobID, req.OrderID, req.Destination, printerID, payload, hash, template.ID, template.Version, now, now)
		if err != nil {
			return "", req.Destination, false, err
		}
	} else {
		return "", req.Destination, false, queryErr
	}

	_, err = tx.Exec(`UPDATE external_events SET job_id=?, status='accepted', updated_at=? WHERE external_event_id=? AND destination=?`, jobID, now, event.ExternalEventID, req.Destination)
	if err != nil {
		return "", req.Destination, false, err
	}
	if err = tx.Commit(); err != nil {
		return "", req.Destination, false, err
	}
	return jobID, req.Destination, false, nil
}

func (d *Daemon) recordCloudEventFailure(eventID, message string) error {
	_, err := d.db.Exec(`INSERT INTO external_events (external_event_id, destination, status, error, received_at, updated_at) VALUES (?, '', 'failed', ?, ?, ?) ON CONFLICT(external_event_id, destination) DO UPDATE SET status='failed', error=excluded.error, updated_at=excluded.updated_at`, eventID, message, time.Now().UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339))
	return err
}

func (d *Daemon) ackCloudEvent(ctx context.Context, client *http.Client, event CloudEvent, jobID, status, message string) error {
	cfg := d.cfg.Cloud
	endpoint, err := cloudEndpoint(cfg.BaseURL, strings.ReplaceAll(cfg.AckPath, "{external_event_id}", url.PathEscape(event.ExternalEventID)))
	if err != nil {
		return err
	}
	body, err := json.Marshal(cloudAck{StationID: cfg.StationID, ExternalEventID: event.ExternalEventID, Destination: event.Print.Destination, JobID: jobID, Status: status, Error: message})
	if err != nil {
		return err
	}
	return d.postCloudJSON(ctx, client, endpoint, body)
}

func (d *Daemon) reportCloudJobStatus(ctx context.Context, client *http.Client, externalEventID, jobID, status, message string) error {
	cfg := d.cfg.Cloud
	if strings.TrimSpace(cfg.StatusPath) == "" {
		return nil
	}
	endpoint, err := cloudEndpoint(cfg.BaseURL, strings.ReplaceAll(cfg.StatusPath, "{external_event_id}", url.PathEscape(externalEventID)))
	if err != nil {
		return err
	}
	body, err := json.Marshal(cloudJobStatus{StationID: cfg.StationID, ExternalEventID: externalEventID, JobID: jobID, Status: status, Error: message})
	if err != nil {
		return err
	}
	return d.postCloudJSON(ctx, client, endpoint, body)
}

func (d *Daemon) postCloudJSON(ctx context.Context, client *http.Client, endpoint *url.URL, body []byte) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	d.setCloudHeaders(request)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
		return fmt.Errorf("cloud HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

func (d *Daemon) setCloudHeaders(request *http.Request) {
	request.Header.Set("Authorization", "Bearer "+d.cfg.Cloud.Token)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "pdv-printer-daemon/1")
}

func cloudEndpoint(base, path string) (*url.URL, error) {
	baseURL, err := url.Parse(strings.TrimRight(base, "/") + "/")
	if err != nil {
		return nil, err
	}
	pathURL, err := url.Parse(strings.TrimLeft(path, "/"))
	if err != nil {
		return nil, err
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/") + "/" + strings.TrimLeft(pathURL.Path, "/")
	baseURL.RawQuery = pathURL.RawQuery
	return baseURL, nil
}

func (d *Daemon) cloudCursor() (string, error) {
	var cursor string
	err := d.db.QueryRow(`SELECT value FROM cloud_state WHERE key='cursor'`).Scan(&cursor)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return cursor, err
}

func (d *Daemon) setCloudCursor(cursor string) error {
	_, err := d.db.Exec(`INSERT INTO cloud_state (key, value, updated_at) VALUES ('cursor', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, cursor, time.Now().UTC().Format(time.RFC3339))
	return err
}
