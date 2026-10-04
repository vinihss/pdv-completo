// Comando gateway: o servidor WebSocket do PDV.
//
// Substitui o `WsGateway` + `outbox-dispatcher` do backend Node.js
// (backend/src/infra/realtime/). Mesma porta de entrada (`/realtime` e
// `/realtime/public`), mesmo token, mesmas regras de room — os clients
// (frontend web, cozinha, garçon, caixa, entregador, gerente) não mudam nada.
//
// ## O que este processo NÃO faz
//
// Nenhuma escrita de domínio. Ele só lê `outbox_event` e entrega. Quem grava o
// outbox continua sendo o backend Node.js, dentro da transação da escrita
// (audit log + outbox na mesma transação, ver docs/agent-backend.md). Por isso
// o gateway nunca precisa de migration nem de schema próprio.
//
// ## Configuração
//
//	PORT             porta HTTP (default 8080)
//	WS_JWT_SECRET    o mesmo JWT_SECRET do backend (fallback: JWT_SECRET)
//	DATABASE_URL     postgres do backend — sem ele o WS sobe mas nenhum evento
//	                 é publicado (útil para subir lado a lado na migração)
//	WS_DISPATCH      liga a publicação do outbox. DESLIGADO por padrão e
//	                 default-deny (só 1/true/yes/on ligam): o gateway só publica
//	                 quando é o dono do /realtime, e quem decide isso é o Caddy,
//	                 não este processo. Ligar no deploy em que o Caddy passa a
//	                 apontar /realtime para o gateway (ver internal/outbox/gate.go)
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"pdv-ws-gateway/internal/auth"
	"pdv-ws-gateway/internal/connmanager"
	"pdv-ws-gateway/internal/db"
	"pdv-ws-gateway/internal/outbox"
	"pdv-ws-gateway/internal/roommanager"
)

// server é tudo que os handlers precisam. Passar por struct em vez de usar
// variáveis de package deixa o roteamento testável sem subir servidor.
//
// O banco entra por `health`, não por um `*sql.DB` cru, porque o /health não
// pode falar com o pool na request (ver healthProbe). O dispatcher do outbox
// continua recebendo o `*sql.DB` direto, em main, porque ele precisa de mais
// que um ping.
type server struct {
	hub     *connmanager.Manager
	verify  func(token string) (*auth.User, error)
	health  *healthProbe
	started time.Time
	version string
}

// upgrader é compartilhado. `CheckOrigin` é o ponto mais sensível de um gateway
// WS: o browser não manda Origin Same-Origin que o default do gorilla aceita.
// O token JWT no subprotocol é o que autentica de fato — um site terceiro que
// consiga um token vazado ainda assim só consegue assinar os rooms que o token
// permite (ver roommanager.CanJoin). Aceitar a origem é o que fecha o resto
// (CSWSH: site do atacante forçando a conexão com o cookie/token da vítima).
//
// A política fica aqui e não no handler para ficar explícita e revisável.
var upgrader = &websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return originAllowed(r) },
}

// allowedOrigins lista as origens aceitas quando WS_ALLOWED_ORIGINS está
// definida. Vazio (default em produção atrás do Caddy) = aceita qualquer
// origem, porque o token no subprotocol é o controle de acesso real.
var allowedOrigins []string

// closeUnauthorized é o code de close que o Node usava (4001). Mantido para
// o log do client não mudar de figura durante a migração.
const closeUnauthorized = 4001

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.Println("[gateway] iniciando WS Gateway")

	addr := ":" + envOr("PORT", "8080")
	secret := firstNonEmpty(os.Getenv("WS_JWT_SECRET"), os.Getenv("JWT_SECRET"))
	databaseURL := os.Getenv("DATABASE_URL")
	allowedOrigins = splitCSV(os.Getenv("WS_ALLOWED_ORIGINS"))

	srv := &server{
		hub:     connmanager.New(),
		started: time.Now(),
		version: version(),
	}
	if secret != "" {
		srv.verify = func(token string) (*auth.User, error) { return auth.Verify(token, secret) }
	} else {
		log.Println("[gateway] AVISO: WS_JWT_SECRET/JWT_SECRET ausente — /realtime vai recusar todo handshake")
	}

	// O dispatcher sobe junto, não sob demanda: evento que ninguém publica é o
	// gateway de pé, saudável e mudo. Ele ser INATIVO por gate (WS_DISPATCH) é
	// um estado legítimo e anunciado — de propósito, e não por omissão (ver
	// internal/outbox/gate.go).
	//
	// `pool` vive no escopo de main, e não dentro do `if`, por causa do
	// shutdown: o `database/sql` segura conexão TCP e não devolve nenhuma no fim
	// do processo, então quem abre é quem fecha.
	var pool *sql.DB
	var dispatcher *outbox.Dispatcher
	if databaseURL != "" {
		var err error
		pool, err = db.Connect(databaseURL)
		if err != nil {
			// Sem banco o gateway ainda serve as conexões (o plano de rollback é
			// voltar o Caddy para o backend com o gateway vivo). Falhar o boot
			// aqui tiraria a possibilidade de rollback sem derrubar o deploy.
			// `db.Connect` já devolveu nil, mas o Close do shutdown é
			// condicional a pool != nil justamente por isso.
			log.Printf("[gateway] AVISO: sem DATABASE_URL acessível (%v) — eventos NÃO serão publicados", err)
		} else {
			// O probe de /health nasce do pool que JÁ respondeu um Ping (Connect
			// só devolve o pool depois de pingar). Esse sucesso é real e com
			// horário real, e é ele que impede o /health de responder degraded
			// nos primeiros milissegundos depois do boot.
			srv.health = newHealthProbe(pool, time.Now())
			dispatcher = outbox.New(pool, srv.hub)
			// Só anuncia "conectado" quando o dispatcher vai mesmo publicar.
			//
			// Com o gate desligado este é o estado NORMAL enquanto o Node é o
			// dono do /realtime, e dizer "conectado" seria mentir: `Run` volta
			// sem criar ticker e nada é publicado. Quem explica esse caso é o
			// próprio dispatcher, em `Run` → `logInactive()`, no log seguinte —
			// com a env, o valor lido e o passo do deploy em que ela deve ser
			// ligada. Repetir aqui só produziria dois logs do mesmo fato em
			// palavras diferentes.
			if outbox.DispatchEnabled() {
				log.Println("[gateway] dispatcher do outbox conectado (WS_DISPATCH ligado) — eventos serão publicados")
			}
		}
	} else {
		log.Println("[gateway] AVISO: DATABASE_URL ausente — eventos NÃO serão publicados")
	}

	// ctx cancelado no primeiro SIGINT/SIGTERM: derruba o dispatcher e libera
	// as conexões antes de o processo sair.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mux := http.NewServeMux()
	mux.HandleFunc("/realtime", srv.handleRealtime)
	mux.HandleFunc("/realtime/public", srv.handleRealtimePublic)
	mux.HandleFunc("/health", srv.handleHealth)

	if dispatcher != nil {
		go dispatcher.Run(ctx)
	}
	// Mesmo prazo de vida do dispatcher: o probe do /health é o que decide se
	// esta instância pode receber tráfego, então ele para junto com o processo.
	if srv.health != nil {
		go srv.health.run(ctx)
	}

	httpServer := &http.Server{
		Addr:    addr,
		Handler: mux,
		// Só o do handshake. Depois do upgrade o gorilla faz hijack e a conexão
		// escapa do http.Server — o prazo do socket passa a ser o pongWait do
		// connmanager. Colocar ReadTimeout/WriteTimeout aqui mataria toda
		// conexão WebSocket no primeiro minuto de vida.
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[gateway] escutando em %s", addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[gateway] falha no listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("[gateway] shutdown pedido")

	// Ordem importa: para de aceitar conexão nova, fecha as abertas (com frame de
	// close, para o client reconectar em outro lugar em vez de esperar o
	// backoff), e só então o banco.
	//
	// O pool vai por último porque é o único recurso que o resto do processo
	// ainda pode estar pedindo: o laço do dispatcher está no mesmo ctx já
	// cancelado, mas um ciclo em andamento segura transação e advisory lock até
	// o fim. Fechar o banco antes das conexões inverteria a ordem e cortaria o
	// dispatcher no meio de um lote.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("[gateway] shutdown não limpo: %v", err)
	}
	srv.hub.Close()
	fechaPool(pool, poolCloseTimeout)
	log.Println("[gateway] encerrado")
}

// poolCloseTimeout é quanto o shutdown espera o pool fechar antes de desistir.
// Curto de propósito: o objetivo é devolver a conexão, não esperar por um banco
// que talvez não volte (ver fechaPool).
const poolCloseTimeout = 2 * time.Second

// fechaPool devolve as conexões do pool na saída do processo.
//
// Existe porque o `database/sql` não devolve conexão nenhuma sozinho: o que a
// chamada faz é marcar o pool como fechado e fechar as conexões ociosas, e é o
// servidor do Postgres que precisa disso para liberar backend e sessão.
//
// A espera é limitada de propósito, e não por superfluidade: o `Close` do driver
// acontece DENTRO do `Close` do pool, e o do lib/pq escreve no socket — contra
// um banco congelado essa escrita não tem prazo nenhum (o `database/sql` não
// põe deadline em fechamento de conexão). Sem teto, fechar o pool seria mais um
// caminho de shutdown pendurado atrás de um banco que não responde, e esperar
// não compra coisa nenhuma: o SO fecha o resto assim que o processo sai.
func fechaPool(pool *sql.DB, timeout time.Duration) {
	if pool == nil {
		return // sem DATABASE_URL, ou Connect falhou: não há o que fechar
	}

	fechou := make(chan struct{})
	go func() {
		defer close(fechou)
		if err := pool.Close(); err != nil {
			log.Printf("[gateway] pool não fechou limpo: %v", err)
		}
	}()

	select {
	case <-fechou:
	case <-time.After(timeout):
		log.Printf("[gateway] pool não fechou em %v (banco travado) — saindo mesmo assim", timeout)
	}
}

// handleRealtime é a rota autenticada. Paridade com `app.get("/realtime")` de
// realtime.routes.ts.
func (s *server) handleRealtime(w http.ResponseWriter, r *http.Request) {
	token := auth.TokenFromHandshake(r)
	if token == "" || s.verify == nil {
		// Nega ANTES do upgrade (o Node negava depois, com close 4001). Para o
		// client é indistinguível — o browser não expõe o status no WebSocket
		// API, só dispara onerror e reconecta pelo backoff. Ganho aqui: não
		// abre socket para um handshake sem token.
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	user, err := s.verify(token)
	if err != nil {
		log.Printf("[gateway] handshake recusado: %v", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := upgrade(w, r, token)
	if err != nil {
		log.Printf("[gateway] upgrade falhou: %v", err)
		return
	}

	registered := s.hub.Add(conn, user.ID, user.Role)
	defer s.hub.Remove(registered)

	// Rooms do perfil já no handshake — o client não precisa pedir nada para
	// estar no lugar certo antes do primeiro evento.
	for _, room := range roommanager.InitialRooms(user.Role, user.ID) {
		s.hub.Join(registered, room)
	}

	log.Printf("[gateway] conectado sub=%s role=%s conn=%s rooms=%v",
		user.ID, user.Role, registered.ID, roommanager.InitialRooms(user.Role, user.ID))

	readLoop(s, registered, func(msg clientMessage) {
		if msg.Room == nil {
			return // join sem room: o Node também ignorava
		}
		if roommanager.CanJoin(user.Role, user.ID, *msg.Room) {
			s.hub.Join(registered, *msg.Room)
			return
		}
		s.hub.Send(registered, mustJSON(map[string]any{
			"type": "join.denied", "room": *msg.Room,
		}))
	})
}

// handleRealtimePublic é a máquina de estado do cliente anônimo: o acompanhamento
// de /pedido, sem JWT. Só `order:<uuid>` é alcançável.
func (s *server) handleRealtimePublic(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrade(w, r, "")
	if err != nil {
		log.Printf("[gateway] upgrade público falhou: %v", err)
		return
	}

	// Sem identidade: userID/role vazios e nenhum room inicial.
	registered := s.hub.Add(conn, "", "")
	defer s.hub.Remove(registered)

	readLoop(s, registered, func(msg clientMessage) {
		if msg.Type != "join" {
			return
		}
		if msg.Room != nil && roommanager.IsOrderRoom(*msg.Room) {
			s.hub.Join(registered, *msg.Room)
			return
		}
		// Negado com o room de volta quando veio string; sem `room`, o Node
		// mandava `room: undefined` (que some do JSON) — aqui vai null.
		var room any
		if msg.Room != nil {
			room = *msg.Room
		}
		s.hub.Send(registered, mustJSON(map[string]any{"type": "join.denied", "room": room}))
	})
}

// clientMessage é o envelope de entrada. `Room` é ponteiro para distinguir
// "não veio" de "veio vazio" — o join sem room é ignorado, o join com room
// vazio é negado.
type clientMessage struct {
	Type string  `json:"type"`
	Room *string `json:"room"`
}

// readLoop é o loop de leitura: consome mensagens do client até o socket
// cair, e trata `sync.request`. O heartbeat (ping/pong) vive no connmanager.
func readLoop(s *server, c *connmanager.Conn, onJoin func(clientMessage)) {
	c.ApplyReadDeadline()
	for {
		raw, err := c.ReadMessage()
		if err != nil {
			// Inclui deadline estourado: é assim que o keepalive descarta
			// conexão morta. Não é erro — não loga.
			return
		}

		var msg clientMessage
		if err := json.Unmarshal([]byte(raw), &msg); err != nil {
			continue // mensagem malformada — o Node também ignorava
		}

		switch msg.Type {
		case "join":
			onJoin(msg)
		case "sync.request":
			// Implementação mínima, igual à do Node: sem buffer de eventos
			// perdidos, o client refaz um GET ao reconectar. Respondemos vazio
			// para não deixar o client esperando uma resposta que não vem.
			s.hub.Send(c, mustJSON(map[string]any{
				"type":      "sync.response",
				"payload":   map[string]any{"events": []any{}},
				"emittedAt": outbox.NowISO(),
			}))
		}
	}
}

// upgrade faz o handshake refletindo o token como subprotocol escolhido.
//
// O reflexo do subprotocol não é detalhe: o browser exige que o servidor escolha
// UM dos protocolos oferecidos e falha a conexão se nenhum for escolhido. O
// Node (biblioteca `ws`) escolhia o primeiro offered automaticamente; no Go é
// preciso dizer qual.
func upgrade(w http.ResponseWriter, r *http.Request, subprotocol string) (*websocket.Conn, error) {
	u := *upgrader // cópia: Upgrader tem estado interno, não compartilhar entre requests
	if subprotocol != "" {
		u.Subprotocols = []string{subprotocol}
	}
	return u.Upgrade(w, r, nil)
}

// handleHealth é o portão do switch blue/green (docs/agent-deploy.md): o que
// responde 503 é o que impede o reload do Caddy. Então o healthcheck pergunta
// ao banco — gateway de pé e incapaz de publicar evento é exatamente o estado
// que não pode virar tráfego.
//
// O que este handler NÃO faz é falar com o banco. Ele só lê o último resultado
// que o healthProbe já deixou guardado, e essa é a única forma de o prazo de
// resposta ser uma garantia e não uma intenção: `sql.DB.PingContext` pode
// bloquear para sempre mesmo com contexto com deadline, então qualquer versão
// deste handler que coloque um ping no caminho da request herda esse "para
// sempre" — e o `http.Server` não tem ReadTimeout/WriteTimeout como rede de
// segurança (ver o comentário na configuração do servidor), porque depois do
// upgrade WebSocket o gorilla faz hijack e a conexão escapa do server.
//
// Os consumidores já são métricos e é por isso que o prazo não pode ser
// negociável: `deploy/switch.sh` e `deploy/probe-availability.sh` chamam com
// `curl -fsS -m 2`, e o healthcheck do Docker usa `timeout: 5s`. Ler um mutex
// custa microssegundos, então sobra uma folga de duas ordens de grandeza.
func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	conns, users := s.hub.Counts()
	body := map[string]any{
		"status":        "ok",
		"version":       s.version,
		"uptimeSeconds": int(time.Since(s.started).Seconds()),
		"connections":   conns,
		"users":         users,
		// `outboxEnabled` responde DUAS coisas, e as duas importam: existe pool
		// (é o mesmo `s.health != nil` do resto do handler — o probe nasce junto
		// com o pool, então nil significa "sem banco", como antes) E o gate
		// `WS_DISPATCH` está ligado.
		//
		// O gate é lido a cada chamada, e não só no boot, porque é assim que o
		// dispatcher decide: `PollOnce` reavalia `DispatchEnabled` a cada ciclo
		// (internal/outbox/outbox.go). As duas leituras vêm da mesma função, então
		// este campo não pode discordar do que o dispatcher está fazendo.
		//
		// Sem o gate, este campo mentia justamente no estado que não pode virar
		// tráfego: pool de pé, banco respondendo, `outboxEnabled:true`, healthcheck
		// verde — e nenhum evento publicado, porque `Run` nem chegou a criar
		// ticker. `outboxEnabled:true` agora quer dizer o que o nome diz.
		//
		// E o inverso é deliberado: com o gate desligado o /health continua
		// 200. Gate desligado é o modo NORMAL de subida lado a lado (o dono do
		// /realtime é o Node, e o gateway só serve as conexões que o Caddy ainda
		// não mandou para lá) — degradar esse estado quebraria o
		// docker compose --profile ws-gateway e o plano de rollback. Quem tem de
		// conferir a posse é o `switch.sh`, que lê a env (deploy/switch.sh).
		"outboxEnabled": s.health != nil && outbox.DispatchEnabled(),
	}
	code := http.StatusOK
	if s.health != nil {
		v := s.health.check()
		// `null` enquanto o banco nunca respondeu, e não 0: 0 diria "respondeu
		// agora", que é o oposto do que este endpoint está tentando dizer.
		if v.lastOK.IsZero() {
			body["databaseLastOkSeconds"] = nil
		} else {
			body["databaseLastOkSeconds"] = int(v.lastOKAge.Seconds())
		}
		if !v.ok {
			body["status"] = "degraded"
			body["databaseError"] = v.dbErrorText()
			code = http.StatusServiceUnavailable
		}
	}
	writeJSON(w, code, body)
}

// dbPinger é o único pedaço de `*sql.DB` que o probe de saúde usa. A troca por
// interface existe por causa de um teste: para provar que o /health responde
// com o banco travado é preciso um pinger que trava de propósito e que ignora
// o prazo do contexto (é o que o lib/pq faz), e não dá para montar isso com um
// `*sql.DB` sem subir um Postgres de verdade. `*sql.DB` satisfaz a interface,
// então a produção continua usando o pool de verdade e nada mais muda.
type dbPinger interface {
	PingContext(ctx context.Context) error
}

// Prazos do probe. São constantes aqui e campos em healthProbe (o construtor
// copia estes valores) porque os testes encolhem tudo para milissegundos em vez
// de dormir segundos por caso.
const (
	// healthPollInterval é de quanto em quanto o fundo pergunta ao banco.
	//
	// Antes cada requisição de /health perguntava — a carga no banco seguia a
	// frequência de quem sonda (Docker a cada 3s, switch.sh a cada 0.5s durante
	// um deploy, probe-availability.sh bem mais). Fixar a cadência desacopla os
	// dois: o banco leva 1 pergunta por segundo por instância, não importa
	// quantos clientes estén apertando o endpoint.
	healthPollInterval = 1 * time.Second

	// healthProbeTimeout é o orçamento passado ao driver em cada pergunta.
	//
	// Ele NÃO é o que garante o prazo do /health, e é importante não confundir
	// os dois: o lib/pq respeita o contexto só no caminho de cancelamento, e o
	// cancelamento é entregue numa conexão TCP nova (pq.(*conn).cancel), que
	// contra um servidor congelado trava tanto quanto a query original. O
	// orçamento serve para o driver marcar a conexão do pool como ruim e o pool
	// não ficar reciclando uma conexão morta. O prazo que decide o /health é
	// healthStaleAfter, porque esse não depende do driver obedecer.
	healthProbeTimeout = 1 * time.Second

	// healthStaleAfter é a idade máxima de um "ok" ainda considerado verdade.
	//
	// Congelar o banco não muda nenhum campo do estado: só faz o tempo passar.
	// E é o tempo que decide — passados 3s sem um ping novo, o último "ok" é
	// história e o /health responde 503 sem esperar por mais nada. Esse é o
	// caminho que transforma "banco travado" em "503 dentro do prazo" em vez
	// de "nunca responde". Três segundos é menor que um ciclo do healthcheck do
	// Docker (interval 3s + timeout 5s em deploy/docker-compose.yml), então
	// uma travada aparece no /health antes do Docker desistir.
	healthStaleAfter = 3 * time.Second

	// healthMaxInFlight é quantas perguntas podem estar em andamento ao mesmo
	// tempo.
	//
	// Uma pergunta que travou não volta nunca — é o defeito que este código
	// existe para contornar. Sem teto, cada sondagem deixaria uma goroutine e
	// uma conexão do pool presas para sempre, e o pool do gateway tem 25
	// conexões: em ~75s de banco travado (2 a cada 3s) o /health esgotaria o
	// pool e levaria junto o dispatcher do outbox, que é justamente o que
	// este endpoint existe para proteger. Com o teto o pior caso é 2 goroutines
	// e 2 conexões presas, para sempre, e o dispatcher continua com as 23 que
	// sobram.
	//
	// Com o teto cheio o fundo para de perguntar em vez de acumular. O
	// destravamento não depende de perguntar: as perguntas presas voltam a
	// responder assim que o banco volta, e a próxima pergunta já é uma conexão
	// nova. O pior caso de uma rede que engole pacote sem nunca devolver RST
	// é ficar em 503 para sempre — e isso é honesto, porque esse banco está
	// realmente fora de alcance.
	healthMaxInFlight = 2
)

// probeState é o resultado do último probe CONCLUÍDO. Só a mudança de `ok` vem
// de um ping que voltou — congelar o banco não mexe em nenhum campo daqui.
type probeState struct {
	ok      bool      // o último probe concluído deu certo
	lastOK  time.Time // quando o último ping bom terminou; zero se nunca houve
	lastErr error     // erro do último probe que falhou; nil se nunca falhou
}

// healthProbe pergunta ao banco em background e guarda o último resultado. O
// handler do /health só lê esse estado, e por isso nunca bloqueia.
//
// A pergunta sai numa goroutine à parte, e é o que mantém a garantia de duas
// formas ao mesmo tempo: o handler nunca espera por um driver que pode não
// voltar, e o número de perguntas presas é limitado por healthMaxInFlight em
// vez de crescer com a frequência de quem sonda.
type healthProbe struct {
	db dbPinger

	// poll, timeout, staleAfter e maxInFlight carregam os valores das
	// constantes acima; o construtor os preenche e os testes os encolhem.
	poll        time.Duration
	timeout     time.Duration
	staleAfter  time.Duration
	maxInFlight int

	mu       sync.Mutex
	st       probeState
	inFlight []time.Time // início de cada tentativa em andamento, em ordem
}

// newHealthProbe cria o probe a partir de um pool que já respondeu um ping
// (`db.Connect` pinga antes de devolver o pool). `connectedAt` é o horário
// desse ping: semê-lo como último "ok" evita o 503 sem sentido logo depois do
// boot, e continua sendo verdade — o banco respondeu, há um instante.
func newHealthProbe(db dbPinger, connectedAt time.Time) *healthProbe {
	return &healthProbe{
		db:          db,
		poll:        healthPollInterval,
		timeout:     healthProbeTimeout,
		staleAfter:  healthStaleAfter,
		maxInFlight: healthMaxInFlight,
		st:          probeState{ok: true, lastOK: connectedAt},
	}
}

// healthVerdict é a leitura do estado já com o prazo aplicado: o handler não
// decide nada, ele só traduz.
type healthVerdict struct {
	ok         bool          // pode responder 200
	dbErr      error         // erro do último probe que falhou; nil se nunca houve
	lastOK     time.Time     // zero se o banco nunca respondeu
	lastOKAge  time.Duration // idade do último "ok"; sem sentido se lastOK é zero
	probingFor time.Duration // há quanto tempo começou a tentativa em andamento
	inFlight   int           // tentativas em andamento
}

// check devolve o estado corrente. É só leitura de mutex — nunca toca no banco,
// e por isso tem prazo de microssegundos em vez de "sem prazo".
func (p *healthProbe) check() healthVerdict {
	p.mu.Lock()
	defer p.mu.Unlock()

	v := healthVerdict{dbErr: p.st.lastErr, inFlight: len(p.inFlight)}
	if !p.st.lastOK.IsZero() {
		v.lastOK = p.st.lastOK
		v.lastOKAge = time.Since(p.st.lastOK)
	}
	// O mais antigo da fila é o que interessa: é há quanto tempo o fundo está
	// sem resposta nenhuma.
	if n := len(p.inFlight); n > 0 {
		v.probingFor = time.Since(p.inFlight[0])
	}
	// Um "ok" só vale enquanto for fresco. Congelar o banco não muda nenhum
	// campo do estado, só o tempo passa — então é o tempo que tem de decidir,
	// e não o driver. É esta linha, e só ela, que garante que o /health nunca
	// responda 200 mentindo.
	v.ok = p.st.ok && v.lastOKAge <= p.staleAfter
	return v
}

// dbErrorText explica o 503.
//
// Errar e calar são estados diferentes e a providência é diferente, então o
// texto separa: erro do driver significa banco recusando ou derrubado (o que
// o pool resolve sozinho); silêncio significa banco travado ou rede engolida,
// em que o driver simplesmente nunca volta.
func (v healthVerdict) dbErrorText() string {
	if v.dbErr != nil {
		return v.dbErr.Error()
	}
	if !v.lastOK.IsZero() {
		return fmt.Sprintf("banco sem responder: último ping bom foi há %.1fs, %d tentativa(s) em andamento há %.1fs",
			v.lastOKAge.Seconds(), v.inFlight, v.probingFor.Seconds())
	}
	return fmt.Sprintf("banco sem responder: %d tentativa(s) em andamento, nenhum ping voltou", v.inFlight)
}

// run é o laço de fundo. Sai junto com o ctx do processo.
func (p *healthProbe) run(ctx context.Context) {
	p.probe(ctx) // sem esperar o primeiro tick: senão o primeiro /health
	// depois do boot encontraria o estado "nunca respondeu" e responderia 503
	t := time.NewTicker(p.poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.probe(ctx)
		}
	}
}

// probe é uma ida ao banco.
func (p *healthProbe) probe(ctx context.Context) {
	p.mu.Lock()
	if len(p.inFlight) >= p.maxInFlight {
		// Já há perguntas presas demais. Não empilha: o teto existe para o
		// /health não virar o que derruba o pool.
		//
		// Isso NÃO trava a recuperação. Medido contra um Postgres de verdade
		// com `docker pause`: a pergunta presa voltou sozinha ~1,2s depois do
		// unpause (o socket tem dado recebido pelo kernel é lido assim que o
		// servidor volta), e voltando ela libera o lugar. O pior caso de um
		// banco que engole pacote sem nunca devolver RST é ficar em 503 para
		// sempre — e isso é honesto, porque esse banco está fora de alcance.
		p.mu.Unlock()
		return
	}
	p.inFlight = append(p.inFlight, time.Now())
	p.mu.Unlock()

	// O ping roda FORA do mutex: trancar durante a consulta devolveria o mesmo
	// defeito que o handler tinha, só que agora no lugar errado.
	pingCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	err := p.db.PingContext(pingCtx)

	p.mu.Lock()
	defer p.mu.Unlock()
	p.releaseLocked()
	if ctx.Err() != nil {
		// Shutdown no meio da pergunta: o cancelamento é da morte do processo,
		// não do banco. Registrar isso derrubaria o /health na janela de saída.
		return
	}
	if err != nil {
		p.st.ok = false
		p.st.lastErr = err
		return
	}
	p.st.ok = true
	p.st.lastErr = nil
	p.st.lastOK = time.Now()
}

// releaseLocked devolve o lugar da tentativa. Com o mutex já tomado.
//
// Remove a mais antiga em vez da última: a ordem em que as perguntas voltam
// não é a ordem em que foram feitas (a primeira, com o pool vazio, espera um
// dial; a seguinte pode usar uma conexão ociosa e responder antes), e é a
// mais antiga que define "há quanto tempo estou preso".
func (p *healthProbe) releaseLocked() {
	if len(p.inFlight) > 0 {
		p.inFlight = p.inFlight[1:]
	}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Só acontece com valor não serializável, e todos os valores daqui são
		// literais de mapa. Se acontecer, melhor um log do que um panic no
		// handler derrubando a instância inteira.
		log.Printf("[gateway] falha ao serializar frame: %v", err)
		return []byte(`{"type":"internal.error"}`)
	}
	return b
}

// originAllowed implementa a política de origem. Vazio em WS_ALLOWED_ORIGINS =
// aceita qualquer origem (o token é o controle de acesso real, e atrás do Caddy
// a checagem de origem HTTP já bloqueia o resto).
func originAllowed(r *http.Request) bool {
	if len(allowedOrigins) == 0 {
		return true
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // client não-browser (Tauri, daemon) não manda Origin
	}
	for _, allowed := range allowedOrigins {
		if origin == allowed {
			return true
		}
	}
	log.Printf("[gateway] origem recusada: %s", origin)
	return false
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func splitCSV(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func version() string {
	if v := os.Getenv("GIT_SHA"); v != "" {
		return v
	}
	return "dev"
}
