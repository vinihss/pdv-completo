package connmanager

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
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
	hub *Manager
	srv *httptest.Server

	// mu protege dialed/registered: quem escreve é o handler, na goroutine do
	// servidor HTTP; quem lê é o teste. O conteúdo das Conn é o Manager que
	// sincroniza — aqui é só o índice.
	mu         sync.Mutex
	dialed     int
	registered []*Conn
}

// publish entrega ao harness a Conn que o handler acabou de criar, na ordem dos
// dials. Os dials são sequenciais e este `dial` só retorna depois de esperar a
// conexão de índice `idx` aparecer, então a ordem da slice é a ordem dos dials.
func (h *harness) publish(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.registered = append(h.registered, c)
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	hub := New()
	h := &harness{hub: hub}
	up := &websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		registered := hub.Add(socket, r.URL.Query().Get("user"), r.URL.Query().Get("role"))
		// Publica ANTES do loop de Join, de propósito. Publicar depois tornaria
		// a publicação dependente do Join, e o `dial` voltaria a poder acordar na
		// janela entre `Add` e `Join` — a janela em que um broadcast não acha a
		// conexão. O `dial` espera a assinatura, não a publicação.
		h.publish(registered)
		for _, room := range r.URL.Query()["room"] {
			hub.Join(registered, room)
		}
		// (read loop só para detectar a queda do cliente)
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
	h.srv = srv
	return h
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
	// `Upgrade` — antes de o handler registrar a conexão e assinar os rooms. O que
	// o teste precisa aqui é da ASSINATURA, não do registro: `Counts()` é
	// satisfeito no `Add`, um passo antes do `Join`, e um broadcast disparado nessa
	// janela não encontra a conexão. Por isso o dial espera `Rooms()`.
	h.mu.Lock()
	idx := h.dialed
	h.dialed++
	h.mu.Unlock()
	h.waitSubscribed(t, idx, rooms)
	return socket
}

// waitSubscribed espera a conexão do dial de índice `idx` existir no registro do
// handler e estar assinando todos os `rooms`. A condição é observável no Manager
// (`Rooms`), não uma contagem: esperar por `Counts()` provaria só que o `Add`
// rodou, e o teste ainda poderia correr entre `Add` e `Join` — foi exatamente
// esse o race que fez este teste falhar de forma intermitente.
func (h *harness) waitSubscribed(t *testing.T, idx int, rooms []string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if c := h.registeredConn(idx); c != nil {
			signed := h.hub.Rooms(c)
			if hasAll(signed, rooms) {
				return
			}
			if !time.Now().Before(deadline) {
				t.Fatalf("timeout esperando a conexão %d assinar %v; assinou %v", idx, rooms, signed)
			}
		} else if !time.Now().Before(deadline) {
			t.Fatalf("timeout esperando o handler registrar a conexão %d", idx)
		}
		// Sono curto de sondagem entre uma condição e outra — o passo em si é
		// esperar `Rooms`, não torcer para a corrida resolver.
		time.Sleep(5 * time.Millisecond)
	}
}

// registeredConn devolve a Conn do dial de índice `idx`, ou nil se o handler
// ainda não publicou. Serve para o teste operar na conexão que ele próprio abriu
// (Join/Leave/fila) sem varrer o map interno do Manager às cegas.
func (h *harness) registeredConn(idx int) *Conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if idx >= len(h.registered) {
		return nil
	}
	return h.registered[idx]
}

// mustConn é registeredConn para quando o dial já esperou a conexão existir: o
// índice é o do dial em que o teste está, não uma busca cega por "a única".
func (h *harness) mustConn(t *testing.T, idx int) *Conn {
	t.Helper()
	if c := h.registeredConn(idx); c != nil {
		return c
	}
	t.Fatalf("o handler não registrou a conexão %d (só há registro depois do dial esperar)", idx)
	return nil
}

// hasAll diz se `signed` cobre `want` (subconjunto: a conexão pode assinar mais
// rooms do que o teste pediu).
func hasAll(signed, want []string) bool {
	set := make(map[string]bool, len(signed))
	for _, room := range signed {
		set[room] = true
	}
	for _, room := range want {
		if !set[room] {
			return false
		}
	}
	return true
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

// registrarEncerrada põe no registro uma conexão JÁ encerrada, sem socket nem
// writePump. Existe para o caso que o harness de verdade não consegue servir: o
// intervalo entre um `Close` e a limpeza de uma conexão real é de microsegundos
// (a writePump fecha o socket e o read loop do handler chama `Remove` atrás), e
// um teste que dependesse dessa janela seria flaky nos dois sentidos — às vezes
// sem ver a conexão, às vezes sem exercitar o reparo.
func (h *harness) registrarEncerrada(userID, room string) *Conn {
	c := &Conn{
		ID:     newConnID(),
		UserID: userID,
		Role:   "waiter",
		send:   make(chan []byte, sendBuffer),
		rooms:  map[string]bool{room: true},
		closed: make(chan struct{}),
	}
	// `Close` não toca no socket — é só o sinal de fim —, então encerrar uma
	// conexão que nunca teve writePump não deixa nada pendurado. É justamente o
	// que o `defer` da pump faria se ela existisse: a limpeza pelo read loop do
	// handler, que é o que este teste precisa observar como reparo, não como
	// prévia.
	c.Close()

	h.hub.mu.Lock()
	h.hub.conns[c.ID] = c
	h.hub.users[userID] = map[string]*Conn{c.ID: c}
	h.hub.mu.Unlock()
	return c
}

// socketPuro sobe um servidor WS que faz só o upgrade e entrega o socket, para o
// teste montar a Conn na mão. O harness não serve: a `Add` já sobe a writePump
// junto, e para observar o backlog no momento do fim é preciso que a fila esteja
// cheia ANTES de existir pump.
func socketPuro(t *testing.T) (servidor, cliente *websocket.Conn) {
	t.Helper()

	up := &websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	entregues := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		// Depois do upgrade a conexão é do gorilla e escapa do http.Server: o
		// handler pode voltar sem derrubar o socket.
		entregues <- socket
	}))
	t.Cleanup(srv.Close)

	cliente, _, err := websocket.DefaultDialer.Dial(strings.Replace(srv.URL, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatalf("não consegui conectar: %v", err)
	}
	t.Cleanup(func() { cliente.Close() })

	return <-entregues, cliente
}

// readUntilEnd lê até o servidor encerrar a conexão e devolve os frames de dados
// que chegaram antes. Difere de `expectNoFrame` no que espera um FIM positivo:
// um timeout estoura o teste, porque um cliente com o socket pendurado é
// justamente o sintoma que o encerramento precisa evitar — e um prazo estourado
// não pode passar por "terminou".
func readUntilEnd(t *testing.T, c *websocket.Conn) []string {
	t.Helper()
	if err := c.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("setReadDeadline: %v", err)
	}
	var frames []string
	for {
		_, payload, err := c.ReadMessage()
		if err == nil {
			frames = append(frames, string(payload))
			continue
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			t.Fatalf("o servidor não encerrou a conexão: %v", err)
		}
		return frames
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

func TestLeaveCancelaAssinatura(t *testing.T) {
	h := newHarness(t)
	c := h.dial(t, userA, "deliveries")

	// Ache a Conn registrada para sair pelo mesmo caminho do handler.
	conns, users := h.hub.Counts()
	if conns != 1 || users != 1 {
		t.Fatalf("precondição falhou: %d conexões, %d usuários", conns, users)
	}
	registered := h.mustConn(t, 0)

	// Prova de que o `Leave` é o que cancela, e não uma assinatura que nunca
	// chegou: enquanto `deliveries` estiver assinado, o broadcast entrega. Sem
	// esta linha o teste passaria pelo motivo errado sempre que o `Join` do
	// handler não tivesse rodado — `Leave` viraria no-op e o 0 viria de graça.
	if got := h.hub.BroadcastToRoom("deliveries", []byte(`{"type":"delivery.assigned"}`)); got != 1 {
		t.Fatalf("precondição falhou: antes do leave o broadcast entregou para %d, quer 1", got)
	}
	readFrame(t, c) // consome o frame da pré-condição, para o expectNoFrame valer

	h.hub.Leave(registered, "deliveries")
	if got := h.hub.BroadcastToRoom("deliveries", []byte(`{"type":"delivery.assigned"}`)); got != 0 {
		t.Errorf("entregou para %d conexões depois do leave, quer 0", got)
	}
	expectNoFrame(t, c)
}

func TestJoinEIdempotente(t *testing.T) {
	h := newHarness(t)
	h.dial(t, userA)
	registered := h.mustConn(t, 0)

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

	// Broadcast depois de fechar tudo não pode entrar em panic nem mexer no
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
	registered := h.mustConn(t, 0)

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
	registered := h.mustConn(t, 0)

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

// ---------------------------------------------------------------------------
// Encerrar enquanto se publica.
//
// O par encerrar+broadcast é caminho normal, não exótico: o cliente fecha a aba
// (readPump → Remove) no mesmo instante em que o dispatcher do outbox publica
// (BroadcastToRoom). As duas pontas não dividem nada além da própria conexão — o
// broadcast solta o lock antes de enviar, e o Remove solta antes de fechar —, o
// que as torna genuinamente concorrentes.
//
// Antes these testes eram o par `close(send)` de um lado e `send <- payload` do
// outro. Com `-race` isso é data race — accuse que nem precisa de sobreposição —;
// sem o detector, na ordem ruim, é panic "send on closed channel" dentro do
// broadcast, que mata a goroutine e, com ela, o processo inteiro e as conexões
// dos outros clientes. Por isso o par abaixo é testado dos dois jeitos: sob
// `-race` para a corrida, e mesmo sem ele porque o panic sozinho já reprova.
// ---------------------------------------------------------------------------

// Fechar uma conexão enquanto um broadcast empurra nela, várias vezes, com
// conexões novas a cada rodada.
//
// A janela real é de nanoseconds, o que não serviria de teste. O que sustenta a
// reprodutibilidade são duas decisões: o par roda muitas vezes, e as duas
// goroutines partem da MESMA barreira, sem qualquer sincronização entre elas. Um
// detector de corrida não exige sobreposição — exige dois acessos sem ordem de
// happening-before, e duas goroutines irmãs liberadas pela mesma barreira não
// têm ordem entre si.
func TestEncerrarDuranteBroadcastNaoCausaCorrida(t *testing.T) {
	h := newHarness(t)

	const (
		iteracoes = 40
		passadas  = 4
		room      = "kitchen-display"
		payload   = `{"type":"order.updated"}`
	)

	for i := 0; i < iteracoes; i++ {
		h.dial(t, userA, room)
		registrada := h.mustConn(t, i)

		larga := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)

		// Metade encerra pelo caminho do readPump (`Remove`: tira do registro e
		// sinaliza o fim); metade só sinaliza o fim (`Conn.Close`), deixando a
		// conexão ainda visível no registro — assim o broadcast do par abaixo a
		// encontra de verdade, em vez de concorrer com um registro já vazio.
		go func(remove bool) {
			defer wg.Done()
			<-larga
			if remove {
				h.hub.Remove(registrada)
				return
			}
			registrada.Close()
		}(i%2 == 0)

		go func() {
			defer wg.Done()
			<-larga
			for j := 0; j < passadas; j++ {
				h.hub.BroadcastToRoom(room, []byte(payload))
			}
		}()

		close(larga)
		wg.Wait()
	}

	// Uma conexão encerrada sem passar pelo `Remove` é devolvida ao registro por
	// quem a encontrar no próximo broadcast, então a cobrança aqui é explícita:
	// fecha o hub e o registro tem que estar vazio. Não dá para exigir que a
	// limpeza tenha caído dentro da janela do teste — ela depende de o broadcast
	// ganhar a corrida, e o teste é justamente sobre não depender disso.
	h.hub.Close()
	if conexoes, usuarios := h.hub.Counts(); conexoes != 0 || usuarios != 0 {
		t.Errorf("registro com %d conexões/%d usuários depois do par encerrar+broadcast", conexoes, usuarios)
	}
}

// O shutdown é o mesmo par pelo outro lado: `Manager.Close` encerra as conexões
// com o dispatcher ainda publicando. Pelo mesmo desenho, o `Close` tira a lista
// sob o lock e encerra fora dele, então ele e o broadcast são concorrentes sem
// nada os separando — e com `close(send)` no caminho do shutdown, o broadcast
// mandava `send` num canal que o `Close` acabara de fechar.
//
// Aqui a janela é larga de propósito (muitas conexões, muitas passadas) porque o
// detector de corrida só acusa um par de acessos que ele não consiga ordenar, e
// o broadcast passa pelo lock do Manager a cada passada: quanto mais pares
// (passada, conexão), maior a chance de algum ficar genuinamente sem ordem. É
// também por isso que o encerramento cede um `Gosched` antes de começar: garante
// que o broadcast entrou no ar, sem criar ordem entre os dois (yield não é
// sincronização).
func TestCloseDoHubComBroadcastConcorrente(t *testing.T) {
	h := newHarness(t)

	const (
		conexoes = 64
		passadas = 5000
		room     = "kitchen-display"
	)

	clientes := make([]*websocket.Conn, 0, conexoes)
	for i := 0; i < conexoes; i++ {
		clientes = append(clientes, h.dial(t, userA, room))
	}

	larga := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-larga
		runtime.Gosched()
		h.hub.Close()
	}()
	go func() {
		defer wg.Done()
		<-larga
		for i := 0; i < passadas; i++ {
			h.hub.BroadcastToRoom(room, []byte(`{"type":"order.updated"}`))
		}
	}()
	close(larga)
	wg.Wait()

	if c, u := h.hub.Counts(); c != 0 || u != 0 {
		t.Errorf("registro com %d conexões/%d usuários depois de Close sob broadcast", c, u)
	}

	// O shutdown não pode deixar socket pendurado: cada cliente tem que ver o fim
	// (close frame ou o fim do stream). `readUntilEnd` estoura o teste se algum
	// deles ficar esperando — e o broadcast concorrente não pode cobrar isso do
	// cliente.
	for _, cliente := range clientes {
		readUntilEnd(t, cliente)
	}
}

// Conexão encerrada é a garantia que dá sentido ao resto do arquivo: depois do
// `Close` o gateway não escreve mais nenhum frame de dados naquele socket, e a
// fila morta não vira lixeira que enche e derruba a conexão de novo. O caminho
// que mais expõe isso é o `Send` direto (resposta de `sync.request`), porque ele
// alcança a conexão mesmo fora do registro — e com `send` fechado era panic, não
// descarte.
func TestConexaoEncerradaParaDeReceberFrames(t *testing.T) {
	h := newHarness(t)
	cliente := h.dial(t, userA, "kitchen-display")
	registrada := h.mustConn(t, 0)

	// Prova de vida antes do fim. Sem ela o teste passa pelo motivo errado: uma
	// conexão que nunca recebeu nada também "não recebe depois".
	if got := h.hub.BroadcastToRoom("kitchen-display", []byte(`{"type":"antes"}`)); got != 1 {
		t.Fatalf("pré-condição: o broadcast entregou para %d conexões, quer 1", got)
	}
	if frame := readFrame(t, cliente); frame != `{"type":"antes"}` {
		t.Fatalf("pré-condição: o cliente recebeu %s", frame)
	}

	h.hub.Remove(registrada)

	// Encerrada, a conexão some da contagem do broadcast e recusa qualquer frame,
	// sem pânico — inclusive no `Send` direto, que a alcança fora do registro.
	// A sondagem é repetida porque o descarte tem que ser decisão, não sorte: o
	// `select` do código anterior escolhia ao acaso entre a fila (já fechada) e o
	// sinal de fim, e só uma das escolhas era o pânico que derrubava o processo.
	if got := h.hub.BroadcastToRoom("kitchen-display", []byte(`{"type":"depois"}`)); got != 0 {
		t.Errorf("o broadcast entregou para %d conexões encerradas, quer 0", got)
	}
	for i := 0; i < 32; i++ {
		h.hub.Send(registrada, []byte(`{"type":"direto"}`))
	}

	for _, frame := range readUntilEnd(t, cliente) {
		if strings.Contains(frame, "depois") || strings.Contains(frame, "direto") {
			t.Errorf("frame recebido depois do fim da conexão: %s", frame)
		}
	}
}

// Quem encerra a conexão deveria sempre passar pelo `Remove`, mas `Conn.Close` é
// público e um caminho futuro pode chamá-lo sozinho. Sem reparo, essa conexão
// ficaria registrada para sempre — segurando room, contando no /health e sendo
// visitada por todo broadcast. O reparo é o `Remove` idempotente no
// `pushClosed`, e este teste é o contrato dele.
func TestConnEncerradoSemRemoveSaiNoProximoBroadcast(t *testing.T) {
	h := newHarness(t)
	h.registrarEncerrada(userA, "kitchen-display")

	if conexoes, usuarios := h.hub.Counts(); conexoes != 1 || usuarios != 1 {
		t.Fatalf("pré-condição: %d conexões/%d usuários registrados, quer 1/1 (o Close não tira do registro)", conexoes, usuarios)
	}

	if got := h.hub.BroadcastToRoom("kitchen-display", []byte(`{"type":"qualquer"}`)); got != 0 {
		t.Errorf("entregou para %d conexões encerradas, quer 0", got)
	}
	if conexoes, usuarios := h.hub.Counts(); conexoes != 0 || usuarios != 0 {
		t.Errorf("a conexão encerrada ficou no registro: %d conexões/%d usuários", conexoes, usuarios)
	}
}

// A garantia de "parou de escrever" precisa valer também para o que JÁ estava na
// fila quando a conexão acabou, que é a janela em que o desenho antigo vazava:
// fechar `send` só sinalizava o fim DEPOIS de a pump entregar o backlog inteiro,
// então um cliente que o gateway já tinha decidido derrubar ainda recebia frames
// de um evento que não era mais dele.
//
// O socket vem de `socketPuro` porque a fila precisa estar cheia antes de existir
// pump — com a `Add` normal a writePump já está drenando desde o primeiro
// milissegundo e a janela não existe para o teste.
func TestWritePumpNaoEscreveFrameDepoisDoFim(t *testing.T) {
	servidor, cliente := socketPuro(t)

	registrada := &Conn{
		ID:     newConnID(),
		send:   make(chan []byte, 4),
		rooms:  map[string]bool{},
		closed: make(chan struct{}),
		socket: servidor,
	}
	for i := 0; i < cap(registrada.send); i++ {
		registrada.send <- []byte(fmt.Sprintf(`{"atrasado":%d}`, i))
	}

	// Encerra antes de a pump existir: o fim é anterior a qualquer escrita, então
	// a fila inteira tem que ser descartada em vez de entregue.
	registrada.Close()
	go registrada.writePump()

	// O único frame que o cliente pode ver depois disso é o de close, e
	// `readUntilEnd` não conta close frame como dado.
	if frames := readUntilEnd(t, cliente); len(frames) != 0 {
		t.Errorf("a pump escreveu %d frame(s) de dados depois do fim: %v", len(frames), frames)
	}
}
