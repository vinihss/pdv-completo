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
//   - O fim da vida de uma conexão é um SINAL, não o fechamento da fila. `send`
//     nunca é fechado: fechar um canal que outra goroutine envia é data race e
//     pode virar panic "send on closed channel" — e panic em goroutine derruba o
//     processo inteiro, levando junto as conexões dos outros clientes. Quem
//     sinaliza o fim é `closed`, que ninguém envia: os senders consultam, a
//     writePump sai por ele.
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
	// pongWait é o quanto se tolera sem heartbeat antes de considerar a conexão
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
	// send é a fila, consumida só pela writePump, e NUNCA é fechada. Fechá-la
	// seria o sinal mais curto de "acabou", mas `close(chan)` num canal que
	// outros enviam é data race — e, pior, pode virar panic "send on closed
	// channel" dentro do broadcast, derrubando o processo. Quem sinaliza o fim
	// é `closed`, que só é fechado (uma vez, pelo `closeOnce`) e nunca recebe.
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

// Remove tira a conexão do registro e sinaliza o fim (a writePump fecha o
// socket). Idempotente: quem chega depois do primeiro `Remove` só repete a
// tentativa de fechar, que o `closeOnce` absorve.
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

// pushResult é o desfecho de um push na fila de uma conexão.
type pushResult int

const (
	// pushOK: o frame entrou na fila e a writePump vai escrevê-lo.
	pushOK pushResult = iota
	// pushClosed: a conexão já foi encerrada. Não há mais writePump drenando a
	// fila, então empilhar aqui só enche o buffer e converte uma conexão morta
	// em "fila cheia" no log.
	pushClosed
	// pushFull: a fila está cheia e o cliente não está consumindo — Slow Client
	// Drop.
	pushFull
)

// offer empurra o payload na fila sem bloquear: com a fila cheia ele desiste na
// hora, nunca segura o broadcast. É o ÚNICO ponto do pacote que envia em `send`,
// e por isso o único lugar onde a garantia "ninguém fecha `send`" precisa ser
// respeitada.
//
// O teste de `closed` vem ANTES do push, e não como caso do mesmo select: um
// select escolhe ao acaso entre os casos prontos, então uma conexão encerrada com
// espaço na fila ora seria contada como entregue, ora cairia no `default` de
// "fila cheia" — que derrubaria de novo, e registraria no log, uma conexão que
// já tinha acabado.
func (c *Conn) offer(payload []byte) pushResult {
	if c.encerrada() {
		return pushClosed
	}
	select {
	case c.send <- payload:
		return pushOK
	default:
		return pushFull
	}
}

// Send empurra um frame para uma conexão específica (respostas de `sync.request`,
// `join.denied`). Não bloqueia: se a fila está cheia, a conexão é encerrada.
func (m *Manager) Send(c *Conn, payload []byte) {
	switch c.offer(payload) {
	case pushOK:
		return
	case pushFull:
		// Fila cheia: cliente não está consumindo. Não vale segurar o broadcast.
		log.Printf("[hub] fila cheia, encerrando conexão lenta %s (%s)", c.ID, c.UserID)
	}
	// `pushClosed` cai aqui sem log: a conexão já foi encerrada, e o `Remove` é
	// idempotente — ele só confirma que ela saiu do registro.
	m.Remove(c)
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
		switch c.offer(payload) {
		case pushOK:
			delivered++
		case pushFull:
			log.Printf("[hub] fila cheia no broadcast para %s, encerrando %s", room, c.ID)
			m.Remove(c)
		case pushClosed:
			// Encerrada entre a cópia e aqui: `Remove` idempotente, e sem log —
			// "fila cheia" seria mentira, não sobrou ninguém lendo esta fila.
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
		switch c.offer(payload) {
		case pushOK:
			delivered++
		default:
			// Fim ou fila cheia levam ao mesmo `Remove`, que engole os dois e é
			// idempotente. Sem log aqui (como antes): o destino é um usuário, e o
			// diagnóstico de fila cheia já sai do `Send` e do `BroadcastToRoom`.
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

// Close encerra todas as conexões. Usado no shutdown, com o dispatcher do outbox
// ainda publicando.
//
// Mesma disciplina do broadcast: a lista sai sob o lock e o encerramento de cada
// conexão acontece fora dele — o `Remove` reentra no mesmo lock, então segurá-lo
// aqui seria reentrância e deadlock imediato. E um `BroadcastToRoom` que pegou a
// conexão no snapshot antes do `Close` não depende de sorte: `offer` devolve
// `pushClosed` e o `Remove` idempotente resolve.
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

// Close encerra a conexão: sinaliza o fim e deixa a writePump mandar o frame de
// close e derrubar o socket. Idempotente — quem chama (readPump, fila cheia,
// shutdown) pode ser mais de um, e o `closeOnce` faz só um deles chegar ao
// `close`. Não toca no socket: só a writePump escreve nele, e o gorilla não
// permite escrita concorrente.
//
// `send` NÃO é fechado, e essa é a decisão que elimina a corrida. Fechar um
// canal pode ser feito por um lado enquanto outro envia no mesmo canal, e isso
// é data race — com chance de virar panic "send on closed channel" dentro de uma
// goroutine, que derruba o processo e leva junto as conexões dos outros clientes.
// Fechar só `closed` dá o mesmo sinal sem o perigo: quem envia já pergunta por
// ele (`offer`) e a writePump sai por ele (`writePump`).
func (c *Conn) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
	})
}

// encerrada diz se o fim da conexão já foi sinalizado. Só para quem decide se
// ainda vale trabalhar nela: `closed` é fechado uma única vez e nunca recebe,
// então o teste é seguro sem lock — ao contrário de `send`, que por isso nunca é
// fechado.
func (c *Conn) encerrada() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// writePump é a ÚNICA a escrever no socket, e cada socket tem exatamente uma.
// Nada aqui pode passar a escrever em paralelo: é a razão de a fila existir.
func (c *Conn) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.socket.Close()
	}()

pump:
	for {
		// `closed` é consultado antes de cada espera para ter PRIORIDADE sobre o
		// backlog: um select escolhe ao acaso entre os casos prontos, e um frame
		// entregue depois do fim seria uma escrita no socket de uma conexão que
		// já não existe.
		select {
		case <-c.closed:
			break pump
		default:
		}

		select {
		case payload := <-c.send:
			// Reconfirma o fim: o close pode ter caído entre o select acima e o
			// receive, e a partir daí a conexão não aceita mais frame nenhum.
			if c.encerrada() {
				break pump
			}
			if !c.writeFrame(payload) {
				return
			}
		case <-c.closed:
			break pump
		case <-ticker.C:
			if !c.writePing() {
				return
			}
		}
	}

	// Fim da conexão: close frame para o cliente reconectar pelo backoff dele em
	// vez de esperar o timeout, e desliga. A fila que sobrou é descartada — quem
	// não estava lendo não a quer, e o `defer` acima fecha o socket de qualquer
	// jeito. Descartar também é o que impede o close frame de ficar atrás de
	// 256 frames num cliente lento.
	_ = c.socket.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(writeWait),
	)
}

// writeFrame escreve um frame de dados. Devolve false no primeiro erro: o peer
// sumiu (ou o prazo estourou) e a pump não tem mais o que fazer.
func (c *Conn) writeFrame(payload []byte) bool {
	if err := c.socket.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		return false
	}
	return c.socket.WriteMessage(websocket.TextMessage, payload) == nil
}

// writePing é o heartbeat, e sai do mesmo lugar por motivo mais forte: ping
// concorrente com um frame de dados já corromperia o frame.
func (c *Conn) writePing() bool {
	if err := c.socket.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		return false
	}
	return c.socket.WriteMessage(websocket.PingMessage, nil) == nil
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
