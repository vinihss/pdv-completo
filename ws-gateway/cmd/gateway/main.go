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
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
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
type server struct {
	hub     *connmanager.Manager
	verify  func(token string) (*auth.User, error)
	db      *sql.DB
	started time.Time
	version string
}

// upgrader é compartilhado. `CheckOrigin` é o ponto mais sensível de um gateway
// WS: o browser não manda Origin Same-Origin que o default do gorilla aceita.
// O token JWT no subprotocol é o que autentica de fato — um site terceiro que
// gotten um token vazado ainda assim só consegue assinar os rooms que o token
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
	// gateway de pé, saudável e mudo.
	var dispatcher *outbox.Dispatcher
	if databaseURL != "" {
		pool, err := db.Connect(databaseURL)
		if err != nil {
			// Sem banco o gateway ainda serve as conexões (o plano de rollback é
			// voltar o Caddy para o backend com o gateway vivo). Falhar o boot
			// aqui tiraria a возможность de rollback sem derrubar o deploy.
			log.Printf("[gateway] AVISO: sem DATABASE_URL acessível (%v) — eventos NÃO serão publicados", err)
		} else {
			srv.db = pool
			dispatcher = outbox.New(pool, srv.hub)
			log.Println("[gateway] dispatcher do outbox conectado")
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
	// backoff), e só então sai. O `defer pool.Close()` abaixo cobre o banco.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("[gateway] shutdown não limpo: %v", err)
	}
	srv.hub.Close()
	log.Println("[gateway] encerrado")
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
// ao banco — gateway de pé e unable a publicar evento é exatamente o estado
// que não pode virar tráfego.
func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	conns, users := s.hub.Counts()
	body := map[string]any{
		"status":        "ok",
		"version":       s.version,
		"uptimeSeconds": int(time.Since(s.started).Seconds()),
		"connections":   conns,
		"users":         users,
		"outboxEnabled": s.db != nil,
	}
	code := http.StatusOK
	if s.db != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.db.PingContext(ctx); err != nil {
			body["status"] = "degraded"
			body["databaseError"] = err.Error()
			code = http.StatusServiceUnavailable
		}
	}
	writeJSON(w, code, body)
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
