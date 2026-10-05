// Package server tem as rotas HTTP: o webhook e o /health.
//
// ## `POST /webhooks/pagarme` faz três coisas, e só três
//
//  1. valida a assinatura;
//  2. grava o evento em `payment_event` (dedupe por `UNIQUE (provider, event_id)`);
//  3. responde 200.
//
// O PROCESSAMENTO é assíncrono (internal/queue), depois do 200. A spec §15 é
// explícita ("o endpoint deve responder rapidamente; não executar operações
// pesadas antes de responder") e o motivo é concreto: o Pagar.me reenvia o mesmo
// evento enquanto não recebe 200, e o boot do ciclo inteiro na requisição
// transformaria um pico de tráfego em reenvio em massa. Gravar antes do 200 é o
// que garante que nenhum evento se perca entre "recebi" e "processei".
//
// ## Um evento duplicado é sucesso, não erro
//
// Duas respostas possíveis, ambas 200:
//
//	evento novo -> `{"received":true,"duplicate":false}`
//	reenvio     -> `{"received":true,"duplicate":true}`
//
// Devolver 4xx para um reenvio faria o Pagar.me reenviar indefinidamente um evento
// que já foi tratado. A idempotência é do índice único, não de um `if` no código —
// e um `SELECT` seguido de `INSERT` seria a mesma lógica com uma janela de
// corrida, porque o provedor pode mandar o mesmo evento duas vezes ao mesmo tempo
// em dois processos HTTP diferentes.
//
// ## A ordem das checagens é o contrato de segurança
//
// Sem `PAGARME_SECRET_KEY` não há como validar, e responder 200 sem verificar
// deixaria qualquer um marcar cobrança como paga chamando este endpoint — a recusa
// é 503, e é a primeira coisa que o handler faz. Depois vem a assinatura (401), e
// só então o parse do corpo (400): quem não se provou não consegue nem fazer o
// endpoint parsear o payload dele.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
	"unicode/utf8"

	"pdv-pagarme-webhook/internal/charge"
	"pdv-pagarme-webhook/internal/inbox"
	"pdv-pagarme-webhook/internal/queue"
	"pdv-pagarme-webhook/internal/signature"
)

// MaxBodyBytes é o teto do corpo do webhook.
//
// Um webhook do Pagar.me é uma cobrança com `items` e `payments`: alguns KB. 1 MiB
// é a mesma ordem do limite do Fastify, e o teto não é decoração: sem ele um
// `POST /webhooks/pagarme` com `Content-Length` gigante aloca a memória antes de
// qualquer validação, e o endpoint é alcançável da internet sem autenticação (a
// autenticação é a assinatura, que só é conferida DEPOIS de ler o corpo).
const MaxBodyBytes = 1 << 20 // 1 MiB

// ResponseTimeout é o prazo de escrita de uma resposta.
//
// Curto de propósito: o handler faz um INSERT e um log, e uma resposta pendurada
// seguraria a conexão e o log. Não é o tempo do Pagar.me: se ele desistir, reenvia
// — e reenviar é seguro por construção (o dedupe).
const ResponseTimeout = 15 * time.Second

// Server é tudo que os handlers precisam. Passar por struct em vez de usar
// variáveis de package deixa o roteamento testável sem subir servidor.
type Server struct {
	// secretKey é a credencial usada para VERIFICAR a assinatura. Vazio = o
	// serviço não está configurado, e o handler responde 503 sem tocar no resto.
	secretKey string
	inbox     InboxStore
	started   time.Time
	version   string
	// health carrega o estado do banco, que o /health só lê (nunca pergunta na
	// request) — ver health.go.
	health *HealthProbe
}

// InboxStore é a parte do `inbox.Store` que o handler usa.
//
// Interface mínima para o teste do 503/401/400/200 montar um store falso e
// exercitar a sequência de checagens sem Postgres. `inbox.Store` satisfaz.
type InboxStore interface {
	Record(ctx context.Context, rawBody []byte, payload *charge.WebhookPayload) (rowID string, isNew bool, err error)
}

// New monta o Server.
func New(secretKey string, store InboxStore, health *HealthProbe, version string) *Server {
	return &Server{
		secretKey: secretKey,
		inbox:     store,
		started:   time.Now(),
		version:   version,
		health:    health,
	}
}

// SemCredencial diz se o serviço está sem `PAGARME_SECRET_KEY`. O `main` usa para
// decidir se sobe o serviço em modo recusa (e o `/health` para degradar).
func (s *Server) SemCredencial() bool { return s.secretKey == "" }

// Rotas devolve o mux do serviço.
//
// Só duas rotas, e as duas têm dono:
//   - `/webhooks/pagarme` é do Caddy (é o que este serviço existe para servir);
//   - `/health` é interno do container (healthcheck do Docker e switch.sh).
//
// Não há rota de leitura de evento, nem de reprocessamento, nem de
// reprocessamento manual da DLQ: qualquer coisa que mude estado de domínio
// continua no Node, e o operador que precisa reprocessar chama o Node.
func (s *Server) Rotas() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/webhooks/pagarme", s.HandleWebhook)
	mux.HandleFunc("/health", s.HandleHealth)
	return mux
}

// HandleWebhook é a porta de entrada do gateway do Pagar.me.
//
// Sem autenticação de sessão — quem chama é o gateway, que se prova pela
// ASSINATURA (HMAC-SHA1 do corpo cru com a secret key), não por token.
func (s *Server) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	// Só POST. O Caddy não restringe por método, e o `http.ServeMux` entrega
	// qualquer método para este handler — sem esta checagem, um `GET
	// /webhooks/pagarme` cairia no caminho de leitura de corpo vazio e
	// responderia 401, o que é um 401 que não significa nada.
	if r.Method != http.MethodPost {
		// 405 com `Allow`, que é o que o contrato HTTP exige. Um 401 aqui seria
		// mentira: o endpoint existe, quem errou foi o método.
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "este endpoint só aceita POST")
		return
	}

	// (1) Sem credencial não há o que validar — 503, nunca 200. A resposta 200
	// seria o pior defeito possível desta rota: qualquer pessoa que descubrisse a
	// URL marcaria uma cobrança como paga, e a reconciliação depois trataria o
	// "pago" inventado como verdade do gateway.
	if s.secretKey == "" {
		log.Println("[server] webhook do pagarme sem PAGARME_SECRET_KEY — recusando (503)")
		writeError(w, http.StatusServiceUnavailable, "pagarme_not_configured",
			"PAGARME_SECRET_KEY não configurada")
		return
	}

	// (2) Corpo CRU, lido UMA vez e guardado. O corpo bruto importa: a assinatura
	// é calculada sobre ele, e re-serializar o objeto parseado muda espaçamento e
	// ordem de chave e a HMAC não bateria. No Node isso exigia um content type
	// parser customizado para preservar `req.rawBody` (http/server.ts:79); o
	// `http.Server` do Go entrega o corpo bruto naturalmente, e a obrigação
	// aqui é passar os bytes ao `signature.Verify` ANTES de qualquer parse.
	raw, err := s.readBody(w, r)
	if err != nil {
		// O erro já foi escrito (413 ou 400).
		return
	}

	// (3) Assinatura. 401 e não 200: quem não se provou não muda estado. E também
	// não pode descobrir se o endpoint existe.
	if !signature.Verify(raw, r.Header.Get("X-Hub-Signature"), s.secretKey) {
		log.Printf("[server] assinatura inválida no webhook do pagarme (content-length=%d)", len(raw))
		writeError(w, http.StatusUnauthorized, "invalid_signature", "assinatura não confere")
		return
	}

	// (4) UTF-8 válido ANTES do insert. Não é preciosismo: `payment_event.payload`
	// é TEXT e o Postgres rejeita byte inválido com "invalid byte sequence for
	// encoding UTF8" — o que viraria um 503 para o Pagar.me reenviar para sempre,
	// com a mensagem do banco no log e nenhuma pista do que era. Um corpo que não
	// é JSON válido cai no mesmo 400 logo abaixo; este é só o caso em que o corpo
	// PARSEIA mas não é UTF-8 (o `json.Unmarshal` do Go substitui byte inválido
	// por U+FFFD em vez de falhar).
	if !utf8.Valid(raw) {
		log.Println("[server] corpo do webhook do pagarme não é UTF-8 válido")
		writeError(w, http.StatusBadRequest, "validation_failed", "corpo não é texto UTF-8 válido.")
		return
	}

	// (5) Parse. Aqui é o primeiro ponto em que o corpo vira objeto, e é DEPOIS
	// da assinatura por construção: quem não tem a secret key não chega a parsear
	// nada.
	//
	// O `objeto` é o que garante que o corpo é um OBJETO, e não só JSON válido:
	// `json.Unmarshal` de `null` numa struct não dá erro (o `null` do JSON é o zero
	// value de tudo), e um webhook cujo corpo é a palavra `null` — que o
	// `json.Unmarshal` aceitaria e deixaria a struct zerada — passaria a chegar no
	// `Record` como se fosse um evento sem id. Checar aqui dá o 400 certo sem
	// gastar uma ida ao banco.
	if !ehObjetoJSON(raw) {
		writeError(w, http.StatusBadRequest, "validation_failed", "corpo não é JSON.")
		return
	}
	var payload charge.WebhookPayload
	if err := jsonUnmarshal(raw, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "validation_failed", "corpo não é JSON.")
		return
	}

	// `event_id` ausente é 4xx e não 5xx: sem ele não há como deduplicar, e
	// deduplicar é o requisito (spec §16). Um 5xx aqui faria o Pagar.me reenviar
	// para sempre um evento que jamais será gravado.
	//
	// (O Node responde 503 neste caso — ver GO-PAGARME-PLAN.md §Divergências.)
	if payload.ID == "" {
		writeError(w, http.StatusBadRequest, "validation_failed", "evento sem id.")
		return
	}

	// (6) Gravação.
	rowID, isNew, err := s.inbox.Record(r.Context(), raw, &payload)
	if err != nil {
		// `ErrNoEventID` já foi barrado acima; se chegar aqui é porque outro
		// chamador do `Record` deixou passar, e a resposta correta é a mesma.
		if errors.Is(err, inbox.ErrNoEventID) {
			writeError(w, http.StatusBadRequest, "validation_failed", "evento sem id.")
			return
		}
		// Só falha de infraestrutura aqui (banco fora). 5xx é o comportamento
		// correto para "não consegui persistir": o Pagar.me reenvia, e o dedupe
		// garante que a segunda tentativa não duplica nada. É diferente de
		// "persisti e não achei correspondente", que é 200 com `duplicate`.
		log.Printf("[server] falha ao gravar o evento do pagarme: %v", err)
		writeError(w, http.StatusServiceUnavailable, "service_unavailable", "não consegui gravar o evento")
		return
	}

	inbox.LogEvento(payload.ID, payload.Type, rowID, isNew)
	// 200 nos dois casos. O processamento é do drain, depois do 200.
	writeJSON(w, http.StatusOK, map[string]any{"received": true, "duplicate": !isNew})
}

// readBody lê o corpo, com teto, e escreve a resposta de erro quando não consegue.
//
// O limite vem do `MaxBytesReader` do próprio `http.Server`: quando o corpo passa
// do teto, a leitura devolve o erro do `MaxBytesReader` — e é por isso que o
// handler precisa checar o erro em vez de assumir que `io.ReadAll` devolveu tudo.
// O 413 é o status certo (o corpo é grande demais para este endpoint), e ele diz
// ao Pagar.me que o problema é o tamanho, o que faz ele desistir em vez de
// reenviar a mesma coisa para sempre.
func (s *Server) readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	limited := http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	raw, err := io.ReadAll(limited)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			log.Printf("[server] corpo do webhook acima de %d bytes", MaxBodyBytes)
			writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large",
				fmt.Sprintf("corpo acima de %d bytes", MaxBodyBytes))
			return nil, err
		}
		// Corpo cortado no meio (conexão caiu): 400. Não é do provedor, e um 5xx
		// aqui faria reenvio de algo que foi um erro de transporte.
		log.Printf("[server] falha ao ler o corpo do webhook: %v", err)
		writeError(w, http.StatusBadRequest, "validation_failed", "não consegui ler o corpo.")
		return nil, err
	}
	return raw, nil
}

// HandleHealth é o portão do deploy.
//
// ## O que este handler NÃO faz
//
// Falar com o banco. Ele só lê o último resultado que o `HealthProbe` já deixou
// guardado, e essa é a única forma de o prazo de resposta ser uma garantia e não
// uma intenção: `sql.DB.PingContext` pode bloquear para sempre mesmo com contexto
// com deadline, então qualquer versão deste handler que coloque um ping no caminho
// da request herda esse "para sempre". Ver health.go para o probe de fundo.
//
// ## O que o 503 decide
//
// O Caddy só começa a apontar `/webhooks/pagarme` para este serviço depois que o
// healthcheck responde 200 — é o mesmo portão do `switch.sh` no backend. E aqui
// o 503 em "sem credencial" é DECISÃO, ao contrário do gateway WS (que responde
// 200 sem pool para permitir rollback):
//
//   - sem credencial, este serviço recusa TODO webhook com 503. Se o healthcheck
//     passasse, o tráfego passaria a ser descartado, e o sintoma seria "o Pagar.me
//     reenvia e nada acontece" — a pior categoria de falha numa caixa. Sem banco
//     é a mesma coisa: `Record` falharia, e o 503 do webhook é o resultado.
//   - o rollback deste serviço é o INVERSO do gateway WS: basta o Caddy voltar a
//     apontar /webhooks/pagarme para o backend, e o Node reassume a fila sozinho
//     (mesmo advisory lock, mesmo worker). Nada aqui precisa ficar de pé para
//     o rollback funcionar.
func (s *Server) HandleHealth(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"status":        "ok",
		"service":       "pagarme-webhook",
		"version":       s.version,
		"uptimeSeconds": int(time.Since(s.started).Seconds()),
		// `webhookEnabled` = tem credencial E tem banco. São as DUAS condições
		// para o webhook funcionar, e o `/health` tem que dizer as duas: um
		// serviço com credencial e sem banco responderia `webhookEnabled:true` e
		// o Caddy pointaria tráfego para um 503 em cada webhook.
		"webhookEnabled": !s.SemCredencial() && s.health != nil && s.health.Conectado(),
		// `webhookOwned` = o Caddy está apontando /webhooks/pagarme para aqui.
		// Só o Caddy sabe, então este campo é a RESPOSTA do operador a "a flag
		// está ligada?": um `false` aqui com o `PAGARME_DRAIN` ligado explica
		// por que dois workers dividem a mesma fila — que é seguro, mas é
		// waste.
		"webhookOwned": queue.DrainEnabled(),
		// `drainEnabled` é o gate de posse do drain (ver internal/queue/gate.go).
		// Ler a env a cada chamada, e não só no boot, é o que mantém o campo
		// HONESTO: `drainEnabled:true` com o Caddy apontando para o Node significa
		// que este processo e o worker do Node estão disputando a mesma fila, e
		// isso precisa aparecer em algum lugar.
		"drainEnabled": queue.DrainEnabled(),
	}
	code := http.StatusOK
	if s.health == nil {
		// Sem pool não há como gravar, então 503.
		body["status"] = "degraded"
		body["databaseError"] = "sem pool: este processo foi booted sem DATABASE_URL utilizável"
		code = http.StatusServiceUnavailable
	} else {
		v := s.health.Check()
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
	if s.SemCredencial() {
		body["status"] = "degraded"
		body["secretKeyError"] = "sem PAGARME_SECRET_KEY: todo webhook é recusado com 503"
		code = http.StatusServiceUnavailable
	}
	writeJSON(w, code, body)
}

// DeadLetters conta os eventos presos na DLQ, para o /health.
//
// Vem do `Reconciler` (que é quem sabe a consulta), e não do `Store` do inbox: o
// inbox grava, o reconciliador lê a fila inteira. Nil = sem banco, e o /health já
// está degradado por causa disso.
type DeadLetterCounter interface {
	CountDeadLettered(ctx context.Context) (int, error)
}

// CountDeadLettered devolve quantos eventos estão na DLQ.
func (s *Server) CountDeadLettered(ctx context.Context, counter DeadLetterCounter) (int, error) {
	if counter == nil {
		return 0, errors.New("sem contador de DLQ: o processo foi booted sem banco")
	}
	return counter.CountDeadLettered(ctx)
}

// ---------------------------------------------------------------------------
// helpers de resposta
// ---------------------------------------------------------------------------

// errorBody é o envelope de erro, e é o MESMO do Node (`{ error: { code, message } }`).
//
// A forma importa porque o `classify` do `nodeapi` a consome (é o que produz a
// `error_message` da inbox quando o endpoint interno recusa), e porque quem lê o
// log de um 4xx aqui está lendo a resposta que o Node leria.
type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeError(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, errorBody{Error: errorDetail{Code: errCode, Message: message}})
}

// ehObjetoJSON diz se o corpo é um objeto JSON (ou seja, abre com `{` depois do
// espaço em branco inicial).
//
// Existe porque `json.Unmarshal([]byte("null"), &struct{})` NÃO dá erro: o `null`
// do JSON é o zero value de tudo, e a struct fica silenciosamente zerada. Um
// webhook com corpo `null` — ou `[]`, ou `42` — passaria então como "evento sem
// id", que é uma resposta diferente e menos informativa.
//
// A checagem é no primeiro BYTE não-espaço, e não um segundo parse: é a mesma
// resposta que o parse daria para tudo que não é objeto, e custa nada.
func ehObjetoJSON(raw []byte) bool {
	for _, b := range raw {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			return true
		default:
			return false
		}
	}
	return false // corpo vazio ou só espaços: não é objeto
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := jsonMarshalEncode(w, body); err != nil {
		// O status já foi escrito, então não dá para mudar. Log e segue: um
		// panic aqui derrubaria a instância inteira por causa de um corpo não
		// serializável, e todos os corpos daqui são structs de campos primitivos.
		log.Printf("[server] falha ao serializar a resposta: %v", err)
	}
}

// jsonUnmarshal e jsonMarshalEncode existem para o pacote ter UM ponto só de
// `encoding/json`, e para o teste conseguir olhar esse ponto sem o resto do pacote
// saber. Em produção são o `json.Unmarshal` e o `json.NewEncoder` da stdlib, que é
// o equivalente de `JSON.parse`/`JSON.stringify` no Node — e o que importa aqui é
// que nenhum dos dois é chamado ANTES da assinatura (ver HandleWebhook).
var (
	jsonUnmarshal     = json.Unmarshal
	jsonMarshalEncode = func(w io.Writer, v any) error { return json.NewEncoder(w).Encode(v) }
)
