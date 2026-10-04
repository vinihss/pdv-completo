package connmanager

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const (
	userA = "11111111-1111-1111-1111-111111111111"
	userB = "22222222-2222-2222-2222-222222222222"
)

// harness sobe um servidor WS que registra tudo no Manager sob teste, para
// exercitar o caminho real (socket, fila, writePump) em vez de mock.
type harness struct {
	hub    *Manager
	srv    *httptest.Server
	dialed int
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	hub := New()
	up := &websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		registered := hub.Add(socket, r.URL.Query().Get("user"), r.URL.Query().Get("role"))
		for _, room := range r.URL.Query()["room"] {
			hub.Join(registered, room)
		}
		//(read loop só para detectar a queda do cliente)
		go func() {
			defer hub.Remove(registered)
			for {
				if _, _, err := socket.ReadMessage(); err != nil {
					return
				}
			}
		}()
	}))

	t.Cleanup(func() {
		hub.Close()
		srv.Close()
	})
	return &harness{hub: hub, srv: srv}
}

func (h *harness) dial(t *testing.T, user string, rooms ...string) *websocket.Conn {
	t.Helper()

	query := []string{"user=" + user}
	for _, room := range rooms {
		query = append(query, "room="+room)
	}
	url := strings.Replace(h.srv.URL, "http://", "ws://", 1) + "?" + strings.Join(query, "&")

	socket, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("não consegui conectar: %v", err)
	}
	t.Cleanup(func() { socket.Close() })

	// `Dial` volta quando o handshake termina, e a resposta é escrita no meio do
	// `Upgrade` — antes de o handler do servidor registrar a conexão no Manager.
	// Sem esperar, um broadcast disparado logo depois do dial contaria conexões
	// que ainda não entraram no registro.
	h.dialed++
	h.waitConns(t, h.dialed)
	return socket
}

// waitConns espera o Manager registrar `want` conexões.
func (h *harness) waitConns(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if conns, _ := h.hub.Counts(); conns == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	conns, _ := h.hub.Counts()
	t.Fatalf("timeout esperando %d conexões registradas, há %d", want, conns)
}

func readFrame(t *testing.T, c *websocket.Conn) string {
	t.Helper()
	if err := c.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("setReadDeadline: %v", err)
	}
	_, payload, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("esperava um frame, veio erro: %v", err)
	}
	return string(payload)
}

// expectNoFrame espera o suficiente para um frame indevido ter chegado, e falha
// se chegar.
func expectNoFrame(t *testing.T, c *websocket.Conn) {
	t.Helper()
	if err := c.SetReadDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		t.Fatalf("setReadDeadline: %v", err)
	}
	if _, payload, err := c.ReadMessage(); err == nil {
		t.Errorf("recebeu frame indevido: %s", payload)
	}
}

func TestBroadcastToRoomEntregaParaAssinante(t *testing.T) {
	h := newHarness(t)
	sala := h.dial(t, userA, "kitchen-display")
	fora := h.dial(t, userB, "cash-drawer")

	if got := h.hub.BroadcastToRoom("kitchen-display", []byte(`{"type":"kitchen.order"}`)); got != 1 {
		t.Errorf("BroadcastToRoom entregou para %d conexões, quer 1", got)
	}

	if frame := readFrame(t, sala); frame != `{"type":"kitchen.order"}` {
		t.Errorf("frame recebido = %s", frame)
	}
	expectNoFrame(t, fora)
}

// Duas abas do mesmo usuário (ou o mesmo garçom no desktop e no celular) têm que
// receber as duas. A versão anterior indexava o room por UserID, então a segunda
// conexão sobrescrevia a primeira no map e um dos aparelhos ficava mudo sem
// nenhum erro — e o registro dizia 1 conexão onde havia 2.
func TestDuasAbasDoMesmoUsuarioRecebemAsDuas(t *testing.T) {
	h := newHarness(t)
	aba1 := h.dial(t, userA, "waiter:"+userA)
	aba2 := h.dial(t, userA, "waiter:"+userA)

	if got := h.hub.BroadcastToRoom("waiter:"+userA, []byte(`{"type":"order.updated"}`)); got != 2 {
		t.Fatalf("BroadcastToRoom entregou para %d conexões, quer 2", got)
	}
	if frame := readFrame(t, aba1); frame != `{"type":"order.updated"}` {
		t.Errorf("aba 1 recebeu %s", frame)
	}
	if frame := readFrame(t, aba2); frame != `{"type":"order.updated"}` {
		t.Errorf("aba 2 recebeu %s", frame)
	}

	if _, users := h.hub.Counts(); users != 1 {
		t.Errorf("Counts() viu %d usuários, quer 1 (as duas abas são o mesmo)", users)
	}
}

func TestBroadcastToUserChegaEmTodasAsAbas(t *testing.T) {
	h := newHarness(t)
	celular := h.dial(t, userA, "alerts:user:"+userA)
	desktop := h.dial(t, userA, "alerts:user:"+userA)
	outro := h.dial(t, userB, "alerts:user:"+userB)

	if got := h.hub.BroadcastToUser(userA, []byte(`{"type":"alert.created"}`)); got != 2 {
		t.Fatalf("BroadcastToUser entregou para %d, quer 2", got)
	}
	readFrame(t, celular)
	readFrame(t, desktop)
	expectNoFrame(t, outro)
}

func TestLeaveCancalaAssinatura(t *testing.T) {
	h := newHarness(t)
	c := h.dial(t, userA, "deliveries")

	// Ache a Conn registrada para sair pelo mesmo caminho do handler.
	conns, users := h.hub.Counts()
	if conns != 1 || users != 1 {
		t.Fatalf("precondição falhou: %d conexões, %d usuários", conns, users)
	}
	h.hub.mu.RLock()
	var registered *Conn
	for _, candidate := range h.hub.conns {
		registered = candidate
	}
	h.hub.mu.RUnlock()

	h.hub.Leave(registered, "deliveries")
	if got := h.hub.BroadcastToRoom("deliveries", []byte(`{"type":"delivery.assigned"}`)); got != 0 {
		t.Errorf("entregou para %d conexões depois do leave, quer 0", got)
	}
	expectNoFrame(t, c)
}

func TestJoinEIdempotente(t *testing.T) {
	h := newHarness(t)
	h.dial(t, userA)

	h.hub.mu.RLock()
	var registered *Conn
	for _, candidate := range h.hub.conns {
		registered = candidate
	}
	h.hub.mu.RUnlock()

	for i := 0; i < 3; i++ {
		h.hub.Join(registered, "inventory")
	}
	if rooms := h.hub.Rooms(registered); len(rooms) != 1 {
		t.Errorf("rooms = %v, quer exatamente 1 (join repetido não duplica)", rooms)
	}
}

func TestRemoveLiberaORegistro(t *testing.T) {
	h := newHarness(t)
	h.dial(t, userA, "kitchen-display")

	if conns, _ := h.hub.Counts(); conns != 1 {
		t.Fatalf("precondição falhou: %d conexões", conns)
	}

	h.hub.Close()

	// Broadcast depois de fechar tudo não pode entrar em panic nem distal do
	// registro vazio (o shutdown chama isso com o dispatcher ainda no ar).
	if got := h.hub.BroadcastToRoom("kitchen-display", []byte(`{"type":"x"}`)); got != 0 {
		t.Errorf("entregou para %d conexões com o hub fechado, quer 0", got)
	}
	if conns, _ := h.hub.Counts(); conns != 0 {
		t.Errorf("registro com %d conexões depois de Close", conns)
	}
}

func TestCloseEhIdempotente(t *testing.T) {
	h := newHarness(t)
	h.dial(t, userA)

	h.hub.mu.RLock()
	var registered *Conn
	for _, candidate := range h.hub.conns {
		registered = candidate
	}
	h.hub.mu.RUnlock()

	// read loop, timeout do socket e shutdown podem chamar Close ao mesmo tempo.
	h.hub.Remove(registered)
	h.hub.Remove(registered)
	registered.Close()
	registered.Close()

	if conns, _ := h.hub.Counts(); conns != 0 {
		t.Errorf("registro com %d conexões", conns)
	}
}

// IDs de conexão não podem colidir. A versão anterior derivava o id de
// time.Now() + uma letra — duas abas abertas na mesma hora colidiam e uma
// sobrescrevia a outra no map.
func TestIDsDeConexaoSaoUnicos(t *testing.T) {
	const n = 50

	seen := make(map[string]bool, n)
	for i := 0; i < n; i++ {
		id := newConnID()
		if seen[id] {
			t.Fatalf("id de conexão repetido: %s", id)
		}
		seen[id] = true
	}
	if len(seen) != n {
		t.Errorf("gerados %d ids distintos, quer %d", len(seen), n)
	}
}

// O deadline de escrita tem que existir: sem ele, um cliente que parou de ler
// segura a fila e o broadcast inteiro para trás.
func TestFilaCheiaNaoTravaOBroadcast(t *testing.T) {
	h := newHarness(t)
	h.dial(t, userA, "kitchen-display")

	// Enche a fila direto, sem passar pelo socket — é o cenário "cliente parou
	// de ler" sem precisar de um cliente artificialmente lento.
	h.hub.mu.RLock()
	var registered *Conn
	for _, candidate := range h.hub.conns {
		registered = candidate
	}
	h.hub.mu.RUnlock()

	for i := 0; i < sendBuffer; i++ {
		registered.send <- []byte(fmt.Sprintf(`{"n":%d}`, i))
	}

	// Com a fila cheia o push pode falhar (e o frame ser descartado, com a
	// Slow Client Drop derrubando a conexão). O que não pode é bloquear: o
	// resultado é disputado entre a writePump drainando e o fill, então o que
	// se exige aqui é só a conclusão.
	done := make(chan struct{})
	go func() {
		h.hub.BroadcastToRoom("kitchen-display", []byte(`{"type":"cheio"}`))
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("BroadcastToRoom travou com a fila cheia — um cliente lento segura o realtime inteiro")
	}
}
