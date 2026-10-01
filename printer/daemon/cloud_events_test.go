package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCloud é um backend mínimo: serve eventos no polling e grava ACKs e
// relatos de status, na ordem em que chegam.
type fakeCloud struct {
	mu       sync.Mutex
	events   []CloudEvent
	acks     []cloudAck
	statuses []cloudJobStatus
	srv      *httptest.Server
}

func newFakeCloud(t *testing.T, events []CloudEvent) *fakeCloud {
	t.Helper()
	f := &fakeCloud{events: events}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(cloudPollResponse{Events: f.events})
		case strings.HasSuffix(r.URL.Path, "/ack"):
			var a cloudAck
			_ = json.NewDecoder(r.Body).Decode(&a)
			f.acks = append(f.acks, a)
		case strings.HasSuffix(r.URL.Path, "/status"):
			var s cloudJobStatus
			_ = json.NewDecoder(r.Body).Decode(&s)
			f.statuses = append(f.statuses, s)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeCloud) snapshot() ([]cloudAck, []cloudJobStatus) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]cloudAck(nil), f.acks...), append([]cloudJobStatus(nil), f.statuses...)
}

func cloudTestEvent(eventID, cursor, orderID, destination, item string) CloudEvent {
	req := PrintRequest{JobID: "job-" + eventID, OrderID: orderID, Destination: destination}
	req.Order.Number = "#" + orderID
	req.Order.Items = []Item{{Name: item, Quantity: 1}}
	return CloudEvent{ExternalEventID: eventID, Cursor: cursor, Print: req}
}

// capturePrinter aceita conexões TCP e entrega o que recebeu em got.
func capturePrinter(t *testing.T) (string, chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan []byte, 8)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			data, _ := io.ReadAll(conn)
			conn.Close()
			got <- data
		}
	}()
	return ln.Addr().String(), got
}

func withCloud(d *Daemon, f *fakeCloud) {
	d.cfg.Cloud = normalizeCloudConfig(CloudConfig{Enabled: true, BaseURL: f.srv.URL, StationID: "st-1", Token: "tok"})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timeout esperando: %s", what)
}

// Antes: um evento para destino inexistente (ou com conflito de idempotência)
// devolvia erro, o cursor não avançava e o mesmo evento voltava a cada
// polling, bloqueando todos os seguintes da estação.
func TestEventoPermanenteERejeitadoENaoBloqueiaOsSeguintes(t *testing.T) {
	addr, printed := capturePrinter(t)
	d := hardeningDaemon(t, addr, RetryConfig{MaxAttempts: 3, BaseDelaySecs: 1, MaxDelaySecs: 2, PollIntervalSecs: 1})
	cloud := newFakeCloud(t, []CloudEvent{
		cloudTestEvent("evt-1", "c1", "o1", "sem-impressora", "Suco"),
		cloudTestEvent("evt-2", "c2", "o2", "kitchen", "Pizza"),
		cloudTestEvent("evt-3", "c3", "o2", "kitchen", "Outra pizza"), // mesmo pedido, conteúdo diferente
	})
	withCloud(d, cloud)

	d.pollCloudOnce(context.Background(), cloud.srv.Client())

	acks, _ := cloud.snapshot()
	if len(acks) != 3 {
		t.Fatalf("esperava 3 ACKs, veio %d: %+v", len(acks), acks)
	}
	want := []string{"rejected", "accepted", "rejected"}
	for i, a := range acks {
		if a.Status != want[i] {
			t.Errorf("ack %d (%s) = %q, esperado %q", i, a.ExternalEventID, a.Status, want[i])
		}
	}
	if acks[0].Error == "" || acks[2].Error == "" {
		t.Errorf("rejeição deve carregar o motivo: %+v", acks)
	}
	if cursor, _ := d.cloudCursor(); cursor != "c3" {
		t.Fatalf("cursor = %q, esperado c3 (eventos rejeitados não podem travar o avanço)", cursor)
	}

	select {
	case data := <-printed:
		if !bytes.Contains(data, []byte("Pizza")) {
			t.Fatalf("cupom sem o item esperado: %q", data)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("o evento válido não foi impresso")
	}
	waitFor(t, "status sent_to_printer do evt-2", func() bool {
		_, st := cloud.snapshot()
		for _, s := range st {
			if s.ExternalEventID == "evt-2" && s.Status == "sent_to_printer" {
				return true
			}
		}
		return false
	})
}

// Antes: o status era reportado uma única vez, logo depois da primeira
// tentativa. Um job que ia para retry_waiting e imprimia depois nunca tinha o
// resultado final informado à nuvem.
func TestStatusFinalChegaDepoisDoRetry(t *testing.T) {
	d := hardeningDaemon(t, "127.0.0.1:1", RetryConfig{MaxAttempts: 5, BaseDelaySecs: 60, MaxDelaySecs: 60, PollIntervalSecs: 1})
	cloud := newFakeCloud(t, nil)
	withCloud(d, cloud)
	client := cloud.srv.Client()

	event := cloudTestEvent("evt-9", "c9", "o9", "kitchen", "Lanche")
	jobID, _, dup, err := d.persistCloudEvent(event)
	if err != nil || dup {
		t.Fatalf("persistCloudEvent: dup=%v err=%v", dup, err)
	}
	if err := d.process(jobID); err == nil {
		t.Fatal("impressora inacessível deveria falhar")
	}
	if got := d.jobStatus(jobID); got != "retry_waiting" {
		t.Fatalf("status = %q, esperado retry_waiting", got)
	}

	d.reportPendingStatuses(context.Background(), client)
	d.reportPendingStatuses(context.Background(), client) // sem mudança: não repete
	if _, st := cloud.snapshot(); len(st) != 1 || st[0].Status != "retry_waiting" || st[0].Error == "" {
		t.Fatalf("relato do retry incorreto: %+v", st)
	}

	// O retry worker (ou uma reimpressão manual) conclui o job depois.
	d.finishJob(jobID, "sent_to_printer", nil)
	d.reportPendingStatuses(context.Background(), client)
	d.reportPendingStatuses(context.Background(), client)
	_, st := cloud.snapshot()
	if len(st) != 2 || st[1].Status != "sent_to_printer" || st[1].ExternalEventID != "evt-9" || st[1].JobID != jobID {
		t.Fatalf("status final não chegou à nuvem: %+v", st)
	}
}

func TestStatusNaoReportadoQuandoNuvemFalhaETentaDeNovo(t *testing.T) {
	d := hardeningDaemon(t, "127.0.0.1:1", RetryConfig{MaxAttempts: 5, BaseDelaySecs: 60, MaxDelaySecs: 60, PollIntervalSecs: 1})
	var fail = true
	var mu sync.Mutex
	var posts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		posts++
		if fail {
			http.Error(w, "indisponível", http.StatusServiceUnavailable)
		}
	}))
	t.Cleanup(srv.Close)
	d.cfg.Cloud = normalizeCloudConfig(CloudConfig{Enabled: true, BaseURL: srv.URL, StationID: "st", Token: "t"})

	jobID, _, _, err := d.persistCloudEvent(cloudTestEvent("evt-5", "c5", "o5", "kitchen", "Café"))
	if err != nil {
		t.Fatal(err)
	}
	d.finishJob(jobID, "failed", nil)

	d.reportPendingStatuses(context.Background(), srv.Client()) // nuvem fora do ar
	mu.Lock()
	fail = false
	mu.Unlock()
	d.reportPendingStatuses(context.Background(), srv.Client()) // volta: deve reenviar
	d.reportPendingStatuses(context.Background(), srv.Client()) // já entregue: silêncio

	mu.Lock()
	defer mu.Unlock()
	if posts != 2 {
		t.Fatalf("POSTs = %d, esperado 2 (1 falha + 1 sucesso)", posts)
	}
}

// Bancos criados antes da coluna reported_status não podem reenviar à nuvem o
// histórico inteiro na primeira subida da nova versão.
func TestMigracaoNaoReenviaHistoricoDeStatus(t *testing.T) {
	d := hardeningDaemon(t, "127.0.0.1:1", RetryConfig{})
	jobID, _, _, err := d.persistCloudEvent(cloudTestEvent("evt-old", "c1", "old", "kitchen", "Antigo"))
	if err != nil {
		t.Fatal(err)
	}
	d.finishJob(jobID, "sent_to_printer", nil)
	if _, err := d.db.Exec(`ALTER TABLE external_events DROP COLUMN reported_status`); err != nil {
		t.Skipf("SQLite sem DROP COLUMN: %v", err)
	}
	if err := migrate(d.db); err != nil {
		t.Fatal(err)
	}
	var reported string
	if err := d.db.QueryRow(`SELECT COALESCE(reported_status,'') FROM external_events WHERE external_event_id='evt-old'`).Scan(&reported); err != nil {
		t.Fatal(err)
	}
	if reported != "sent_to_printer" {
		t.Fatalf("reported_status = %q; o histórico seria reenviado", reported)
	}
	if err := migrate(d.db); err != nil { // idempotente
		t.Fatalf("segunda migração: %v", err)
	}
}

func TestQRCodeNaoAceitaComandosNemTamanhoExcessivo(t *testing.T) {
	tpl := Template{ID: "qr", Destination: "fiscal", Columns: 48, Blocks: []Block{{Type: "qrcode", Value: "{{fiscal.qr_code_url}}"}}}

	var order Order
	order.Fiscal.QRCodeURL = "http://a\x1d\x56\x00b\n"
	out, err := render(tpl, order)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out, []byte{0x1d, 0x56}) || bytes.Contains(out, []byte{0x1b, 0x70}) || bytes.Contains(out, []byte{0x00, 'b'}) {
		t.Fatalf("bytes de controle do pedido chegaram à impressora: %x", out)
	}
	if !bytes.Contains(out, []byte("http://aVb")) {
		t.Fatalf("conteúdo do QR sanitizado ausente: %q", out)
	}

	// 65540 bytes: o tamanho de 16 bits daria a volta e vazaria o resto como comandos.
	order.Fiscal.QRCodeURL = "http://x/" + strings.Repeat("A", 65530)
	if _, err := render(tpl, order); err == nil {
		t.Fatal("QR acima do limite deveria falhar em vez de gerar bytes corrompidos")
	}

	order.Fiscal.QRCodeURL = ""
	if out, err := render(tpl, order); err != nil || bytes.Contains(out, []byte{0x1d, 0x28, 0x6b}) {
		t.Fatalf("QR vazio não deveria emitir comandos (err=%v)", err)
	}
}

func TestValidatePrintRequestLimitesDeCampo(t *testing.T) {
	valid := func() PrintRequest {
		r := PrintRequest{JobID: "j", OrderID: "o", Destination: "kitchen"}
		r.Order.Items = []Item{{Name: "Pizza", Quantity: 1}}
		return r
	}
	if err := validatePrintRequest(valid()); err != nil {
		t.Fatalf("pedido válido rejeitado: %v", err)
	}
	cases := map[string]func(*PrintRequest){
		"nome do item longo":   func(r *PrintRequest) { r.Order.Items[0].Name = strings.Repeat("x", maxItemName+1) },
		"obs do item longa":    func(r *PrintRequest) { r.Order.Items[0].Notes = strings.Repeat("x", maxItemNotes+1) },
		"adicionais demais":    func(r *PrintRequest) { r.Order.Items[0].Addons = make([]string, maxAddons+1) },
		"adicional longo":      func(r *PrintRequest) { r.Order.Items[0].Addons = []string{strings.Repeat("x", maxItemName+1)} },
		"observação do pedido": func(r *PrintRequest) { r.Order.Notes = strings.Repeat("x", 2001) },
		"endereço longo":       func(r *PrintRequest) { r.Order.Delivery.Address = strings.Repeat("x", 301) },
		"qr acima do limite":   func(r *PrintRequest) { r.Order.Fiscal.QRCodeURL = strings.Repeat("x", qrMaxBytes+1) },
		"total negativo":       func(r *PrintRequest) { r.Order.TotalCents = -1 },
		"troco negativo":       func(r *PrintRequest) { r.Order.Payment.ChangeCents = -1 },
	}
	for name, mutate := range cases {
		req := valid()
		mutate(&req)
		if err := validatePrintRequest(req); err == nil {
			t.Errorf("%s: deveria ser rejeitado", name)
		}
	}
}
