// Package connmanager é o registro de conexões e o hub de broadcast: guarda quem
// está conectado, em quais rooms, e escreve nos sockets.
//
// Modelo: cada conexão tem uma `send` channel bufferizada e UMA goroutine
// (`writePump`) que é a única a escrever no socket. O broadcast só empurra bytes
// na channel. Duas consequências que explicam o desenho:
//
//   - `*websocket.Conn` não permite escrita concorrente. Com escrita inline no
//     broadcast, dois eventos para o mesmo cliente no mesmo instante corrompiam o
//     frame. Uma fila por conexão serializa sem lock.
//   - Um cliente lento não segura o broadcast inteiro. O push é não-bloqueante
//     (select/default): se a fila está cheia, a conexão está morta na prática — o
//     Node.js fazia `socket.send()` síncrono e segurava todos os outros. Aqui a
//     Slow Client Drop fecha só ela, e o client reconecta pelo backoff dele.
package connmanager

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// writeWait é o prazo de uma escrita. Passou disso, o peer não está lendo.
	writeWait = 10 * time.Second
	// pongWait é o quanto tolerate sem heartbeat antes de considerar a conexão
	// morta. O Node.js NÃO tinha ping/pong — a queda só era percebida no TCP.
	// Aqui a conexão morta é liberada em ~1min em vez de vazar room até o
	// processo reiniciar.
	pongWait = 60 * time.Second
	// pingPeriod precisa ser < pongWait (RFC 6455 sugere 9/10) ou a conexão mata
	// antes de o primeiro ping sair.
	pingPeriod = (pongWait * 9) / 10
	// sendBuffer é a fila por conexão: 256 frames ≈ dezenas de segundos de
	// backlog para um cliente emprestando CPU.
	sendBuffer = 256
)

// Conn é uma conexão viva.
type Conn struct {
	ID     string
	UserID string
	Role   string

	socket *websocket.Conn
	// send é consumida só pela writePump. Fechada em Close, o que encerra o
	// websocket de forma limpa (frame de close) em vez de largar o socket.
	send chan []byte
	// rooms é do usuário desta conexão; guardado sob o lock do Manager, nunca
	// tocado pela writePump.
	rooms map[string]bool

	closeOnce sync.Once
	closed    chan struct{}
}

// Manager é o registro de conexões.
type Manager struct {
	mu    sync.RWMutex
	conns map[string]*Conn
	// users mapeia userID→{connID→conn} como SET, não slice. Com slice, o
	// broadcast ao usuário removeria duplicatas na primeira limpeza e perderia
	// conexões — a versão anterior indexava o room por UserID e fazia exatamente
	// isso: duas abas do mesmo garçom colapsavam em uma.
	users map[string]map[string]*Conn
}

// New cria um Manager vazio.
func New() *Manager {
	return &Manager{
		conns: make(map[string]*Conn),
		users: make(map[string]map[string]*Conn),
	}
}

// Add registra a conexão e sobe a writePump. Devolve a Conn pronta para o
// handshake de rooms e para o read loop.
//
// `socket` já vem upgraded pelo handler; o Manager assume a posse e fecha em
// Remove/Close.
func (m *Manager) Add(socket *websocket.Conn, userID, role string) *Conn {
	c := &Conn{
		ID:     newConnID(),
		UserID: userID,
		Role:   role,
		socket: socket,
		send:   make(chan []byte, sendBuffer),
		rooms:  make(map[string]bool),
		closed: make(chan struct{}),
	}

	m.mu.Lock()
	m.conns[c.ID] = c
	if m.users[userID] == nil {
		m.users[userID] = make(map[string]*Conn)
	}
	m.users[userID][c.ID] = c
	m.mu.Unlock()

	go c.writePump()
	return c
}

// Remove tira a conexão do registro e fecha o socket. Idempotente.
func (m *Manager) Remove(c *Conn) {
	if c == nil {
		return
	}
	m.mu.Lock()
	if _, ok := m.conns[c.ID]; ok {
		delete(m.conns, c.ID)
		if set := m.users[c.UserID]; set != nil {
			delete(set, c.ID)
			if len(set) == 0 {
				delete(m.users, c.UserID)
			}
		}
	}
	m.mu.Unlock()

	c.Close()
}

// Join assina um room. Idempotente por room.
func (m *Manager) Join(c *Conn, room string) {
	m.mu.Lock()
	c.rooms[room] = true
	m.mu.Unlock()
}

// Leave cancela a assinatura.
func (m *Manager) Leave(c *Conn, room string) {
	m.mu.Lock()
	delete(c.rooms, room)
	m.mu.Unlock()
}

// Rooms devolve a cópia das assinaturas — o caller não deve poder mutar o
// estado sob outro lock.
func (m *Manager) Rooms(c *Conn) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]string, 0, len(c.rooms))
	for room := range c.rooms {
		out = append(out, room)
	}
	return out
}

// Send empurra um frame para uma conexão específica (respostas de `sync.request`,
// `join.denied`). Não bloqueia: se a fila está cheia, a conexão é encerrada.
func (m *Manager) Send(c *Conn, payload []byte) {
	select {
	case c.send <- payload:
	case <-c.closed:
	default:
		// Fila cheia: cliente não está consumindo. Não vale segurar o broadcast.
		log.Printf("[hub] fila cheia, encerrando conexão lenta %s (%s)", c.ID, c.UserID)
		m.Remove(c)
	}
}

// BroadcastToRoom entrega um frame já serializado a todas as conexões que
// assinam `room`. É a chamada do dispatcher do outbox.
//
// Retorna quantas conexões receberam. Zero não é erro: o Node também marca o
// evento como publicado sem assinante (ver pollOutboxOnce) — evento perdido é
// recuperado pelo reload por REST do client, redelivery não existe.
func (m *Manager) BroadcastToRoom(room string, payload []byte) int {
	m.mu.RLock()
	targets := make([]*Conn, 0, 8)
	for _, c := range m.conns {
		if c.rooms[room] {
			targets = append(targets, c)
		}
	}
	m.mu.RUnlock()

	// Fora do lock: `Send` pode chamar `Remove`, que pega o lock de escrita —
	// segurar o RLock ali é deadlock imediato (RWMutex não é reentrante nem
	// sofre upgrade de RLock→Lock).
	delivered := 0
	for _, c := range targets {
		select {
		case c.send <- payload:
			delivered++
		case <-c.closed:
		default:
			log.Printf("[hub] fila cheia no broadcast para %s, encerrando %s", room, c.ID)
			m.Remove(c)
		}
	}
	return delivered
}

// BroadcastToUser entrega a todas as conexões de um usuário (todas as abas,
// todos os aparelhos).
func (m *Manager) BroadcastToUser(userID string, payload []byte) int {
	m.mu.RLock()
	targets := make([]*Conn, 0, 4)
	for _, c := range m.users[userID] {
		targets = append(targets, c)
	}
	m.mu.RUnlock()

	delivered := 0
	for _, c := range targets {
		select {
		case c.send <- payload:
			delivered++
		case <-c.closed:
		default:
			m.Remove(c)
		}
	}
	return delivered
}

// Counts devolve (conexões, usuários distintos) — para o /health.
func (m *Manager) Counts() (conns, users int) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.conns), len(m.users)
}

// Close encerra todas as conexões. Usado no shutdown.
func (m *Manager) Close() {
	m.mu.Lock()
	all := make([]*Conn, 0, len(m.conns))
	for _, c := range m.conns {
		all = append(all, c)
	}
	m.mu.Unlock()

	for _, c := range all {
		m.Remove(c)
	}
}

// Close encerra a conexão: manda o frame de close uma vez e aborta o socket.
// Idempotente — quem chama (readPump, send-cheio, shutdown) pode ser mais de um.
func (c *Conn) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
		// Fechar `send` sinaliza o fim para a writePump, que manda o close frame
		// e fecha o socket. Fechar `closed` antes garante que ninguém mais
		// escreva na fila depois do fim.
		close(c.send)
	})
}

// writePump é a ÚNICA a escrever no socket.
func (c *Conn) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.socket.Close()
	}()

	for {
		select {
		case payload, ok := <-c.send:
			if !ok {
				// Fim da fila: handshake de close e desliga.
				_ = c.socket.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
					time.Now().Add(writeWait),
				)
				return
			}
			if err := c.socket.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if err := c.socket.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.socket.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if err := c.socket.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// ApplyReadDeadline arma o deadline de leitura e o handler de pong que o
// writePump usa como heartbeat. Sem isso, uma conexão meio-aberta (TCP morto sem
// RST) fica registrada para sempre, ocupando room sem receber nada.
func (c *Conn) ApplyReadDeadline() {
	c.socket.SetReadLimit(64 << 10)
	_ = c.socket.SetReadDeadline(time.Now().Add(pongWait))
	c.socket.SetPongHandler(func(string) error {
		return c.socket.SetReadDeadline(time.Now().Add(pongWait))
	})
}

// ReadMessage devolve a próxima mensagem de texto do cliente, ou erro
// (incluindo deadline estourado, que é como o keepalive derruba a conexão).
func (c *Conn) ReadMessage() (string, error) {
	_, payload, err := c.socket.ReadMessage()
	if err != nil {
		return "", err
	}
	return string(payload), nil
}

// CloseNow aborta o socket sem handshake — para quem violou o protocolo
// (token inválido). `ws.close(4001, "unauthorized")` do Node é isto aqui: o
// cliente anônimo nunca chega a ver o motivo.
func (c *Conn) CloseNow(code int, reason string) {
	_ = c.socket.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(writeWait),
	)
	c.socket.Close()
}

// newConnID gera um id de conexão opaco. A versão anterior usava
// time.Now() + uma letra — duas abas abertas na mesma hora colidiam, e a
// segunda sobrescrevia a primeira no map (a conexão sumia do registro sem
// aviso, mas o socket ficava vivo: o Node e o Go capacity-limited).
func newConnID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand não falha em Linux sem entropia configurada. Se falhar,
		// o id só precisa ser único o bastante para não colidir no map.
		return "conn-fallback-" + hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return "conn-" + hex.EncodeToString(b[:])
}
