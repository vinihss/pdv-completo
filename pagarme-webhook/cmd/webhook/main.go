// Comando webhook: a receita e o processamento assíncrono do webhook do
// Pagar.me.
//
// Assume do backend Node.js (`backend/src/integrations/pagarme/`) a RECEPÇÃO e o
// PROCESSAMENTO assíncrono. Assume do Gateway de Pagamento (`client.ts`,
// `gateway().find()`) a LEITURA — usada só pela reconciliação.
//
// ## A regra que organiza o sistema inteiro
//
// Go NUNCA fica no caminho síncrono de um request de usuário, e nunca escreve
// estado de domínio. Quando o drain precisa que um evento vire mudança de
// `payment.status`, ele PERGUNTA ao Node (`internal/nodeapi`) e o Node faz a
// transação. `applyCharge`, `bridgePaidToOrder`, `audit_log` e `outbox_event`
// continuam lá — e continuam sendo a ÚNICA implementação da regra financeira.
//
// ## O que este processo NÃO faz
//
// Nenhuma escrita de domínio. Ele grava em `payment_event` (a inbox do webhook, que
// o Node já gravava) e lê `payment` para a reconciliação. Nenhum estado é criado
// aqui: o `payment` continua sendo criado pelo Node, no `createPaymentUsecase`.
//
// ## Configuração
//
//	PORT                             porta HTTP (default 8080)
//	DATABASE_URL                     Postgres do backend — sem ele o serviço sobe
//	                                 mudo (o /health é que diz), e o webhook
//	                                 responde 503
//	PAGARME_SECRET_KEY               a MESMA do backend. Ausente = todo webhook é
//	                                 recusado com 503 (nunca 200: sem a key não há
//	                                 como validar a assinatura, e responder 200
//	                                 deixaria qualquer um marcar cobrança como paga)
//	PAGARME_BASE_URL                 default https://api.pagar.me/core/v5
//	PAGARME_INTERNAL_TOKEN           token opaco para o endpoint interno do Node.
//	                                 Sem ele o drain não sobe (e o /health diz
//	                                 por quê)
//	PAGARME_DRAIN                    liga a drenagem e a reconciliação.
//	                                 DESLIGADO por padrão e default-deny: ver
//	                                 internal/queue/gate.go antes de mexer
//	PAGARME_RECONCILIATION_INTERVAL_MS  cadência da reconciliação (600000 = 10min)
//	GIT_SHA                          aparece no /health como "version"
package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"pdv-pagarme-webhook/internal/db"
	"pdv-pagarme-webhook/internal/gateway"
	"pdv-pagarme-webhook/internal/inbox"
	"pdv-pagarme-webhook/internal/nodeapi"
	"pdv-pagarme-webhook/internal/queue"
	"pdv-pagarme-webhook/internal/server"
)

// poolCloseTimeout é quanto o shutdown espera o pool fechar antes de desistir.
// Curto de propósito: o objetivo é devolver a conexão, não esperar por um banco que
// talvez não volte.
const poolCloseTimeout = 2 * time.Second

// shutdownTimeout é o prazo do `http.Server.Shutdown`.
const shutdownTimeout = 10 * time.Second

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.Println("[pagarme] iniciando o serviço de webhook do Pagar.me")

	addr := ":" + envOr("PORT", "8080")
	secretKey := os.Getenv("PAGARME_SECRET_KEY")
	databaseURL := os.Getenv("DATABASE_URL")
	internalToken := os.Getenv("PAGARME_INTERNAL_TOKEN")
	baseURL := envOr("PAGARME_BASE_URL", gateway.DefaultBaseURL)

	// O `Secret` do logger: o dump do `pg.terminate_backend` nunca sai daqui, e
	// o log não tem nenhum outro lugar onde uma credencial pudesse aparecer.
	if secretKey != "" {
		log.Println("[pagarme] PAGARME_SECRET_KEY carregada — o webhook valida assinatura")
	} else {
		log.Println("[pagarme] AVISO: PAGARME_SECRET_KEY ausente — TODO webhook será recusado com 503 e o " +
			"/health responde 503. Sem a key não há como validar a assinatura, e a alternativa (200 sem " +
			"validar) deixaria qualquer um marcar cobrança como paga")
	}

	// O pool nasce no escopo de `main`, e não dentro de um `if`: o `database/sql`
	// segura conexão TCP e não devolve nenhuma no fim do processo, então quem abre
	// é quem fecha.
	var pool *sql.DB
	var health *server.HealthProbe
	if databaseURL == "" {
		log.Println("[pagarme] AVISO: DATABASE_URL ausente — o webhook não conseguirá GRAVAR a inbox, e cada " +
			"evento do gateway vai receber 503. O serviço sobe para o /health dizer isso")
	} else {
		var err error
		pool, err = db.Connect(databaseURL)
		if err != nil {
			// Sem banco o serviço ainda sobe e serve o /health, que é degradado.
			// Falhar o boot tiraria a possibilidade de diagnóstico — e o rollback
			// deste serviço é o INVERSO do gateway WS: basta o Caddy voltar a
			// apontar /webhooks/pagarme para o Node, e o worker dele reassume a
			// fila sozinho (mesmo advisory lock, mesmo `payment_event`).
			log.Printf("[pagarme] AVISO: sem DATABASE_URL acessível (%v) — o webhook NÃO conseguirá gravar a inbox", err)
		} else {
			// O probe do /health nasce do pool que JÁ respondeu um Ping (`Connect`
			// só devolve o pool depois de pingar). Esse sucesso é real e com
			// horário real, e é ele que impede o /health de responder degraded nos
			// primeiros milissegundos depois do boot.
			health = server.NewHealthProbe(pool, time.Now())
		}
	}

	// O Store da inbox só existe com pool: sem ele não há onde gravar, e o webhook
	// responde 503 — que é o desfecho certo, porque o Pagar.me reenvia.
	//
	// A variável é do tipo da INTERFACE, e não `*inbox.Store`, por um motivo que
	// custa uma leitura e evita um panic: passar um `*inbox.Store` nil para um
	// parâmetro de interface produz uma interface NÃO-nil com ponteiro nil dentro.
	// Aí o `s.inbox == nil` do handler passa, e o primeiro `s.db` estoura com
	// `nil pointer dereference` — derrubando a conexão do webhook SEM resposta
	// nenhuma, enquanto o `/health` segue dizendo 503. Encontrado por smoke test do
	// binário de verdade, e o teste que trava isso é
	// `TestWebhookSemInboxDevolve503SemPanic`.
	var store server.InboxStore
	if pool != nil {
		store = inbox.NewStore(pool, time.Now)
	}

	srv := server.New(secretKey, store, health, version())

	// ---- Node (endpoint interno) e gateway (leitura) ----
	nodeClient := nodeapi.New(envOr("NODE_INTERNAL_URL", "http://backend:3000"), internalToken, nodeapi.DefaultTimeout)
	pagarme := gateway.New(baseURL, secretKey, gateway.DefaultTimeout)

	// A cadência da reconciliação é lida aqui, e o valor entra no log: um
	// `PAGARME_RECONCILIATION_INTERVAL_MS` com typo viraria um ticker que nunca
	// dispara, que é a reconciliação silenciosamente desligada.
	reconciliationMS := envInt("PAGARME_RECONCILIATION_INTERVAL_MS", queue.DefaultReconciliationIntervalMS)
	log.Printf("[pagarme] cadência da reconciliação: %dms (%s)", reconciliationMS, time.Duration(reconciliationMS)*time.Millisecond)

	// ---- workers ----
	//
	// Os três (drain, reconciliação e probe de saúde) sobem juntos, não sob
	// demanda: um serviço que não drena nada é um gateway de pé, saudável e mudo.
	//
	// `PAGARME_DRAIN` é o gate, e ele é default-deny (ver internal/queue/gate.go):
	// desligado, o serviço GRAVA o evento na inbox (o `/webhooks/pagarme` funciona
	// e o dedupe acontece) mas não processa — quem processa é o worker do Node. É o
	// estado NORMAL de subida lado a lado, e é por isso que o `/health` responde 200
	// nele.
	podeDrenar := queue.DrainEnabled()
	var drainer *queue.Drainer
	var reconciler *queue.Reconciler
	if pool != nil && store != nil && podeDrenar && nodeClient.TemToken() && pagarme.TemCredencial() {
		drainer = queue.New(pool, nodeClient)
		reconciler = queue.NewReconciler(pool, nodeClient, pagarme)
		reconciler.DefinirIntervalo(time.Duration(reconciliationMS) * time.Millisecond)
		log.Println("[pagarme] drain e reconciliação LIGADOS (PAGARME_DRAIN=1) — este processo processa a inbox " +
			"e relê o gateway; o worker do Node disputa o MESMO advisory lock e perde o ciclo em silêncio")
	} else {
		// Quem explica o caso é quem tem a informação: o gate, o token, a
		// credencial ou o banco. A ordem é a da长长的 cadeia de pré-requisitos, e
		// a mensagem diz o que fazer.
		queue.LogDrainInativo(motivoDoDrainDesligado(pool, store, podeDrenar, nodeClient, pagarme))
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if drainer != nil {
		go drainer.Run(ctx)
	}
	if reconciler != nil {
		go reconciler.Run(ctx)
	}
	if health != nil {
		go health.Run(ctx)
	}

	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Rotas(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       server.ResponseTimeout + 5*time.Second,
		WriteTimeout:      server.ResponseTimeout,
		// O teto do corpo é do handler (`http.MaxBytesReader`), não daqui: o
		// `MaxBytesReader` precisa do `ResponseWriter` para poder cortar a conexão,
		// e um `MaxHeaderBytes` global não tem nada a ver com isso.
	}

	go func() {
		log.Printf("[pagarme] escutando em %s", addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[pagarme] falha no listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("[pagarme] shutdown pedido")

	// Ordem importa: para de aceitar conexão nova, fecha as abertas, e só então o
	// banco.
	//
	// O pool vai por último porque é o único recurso que o resto do processo ainda
	// pode estar pedindo: um ciclo de drain em andamento segura transação e
	// advisory lock até o fim (e pode estar dentro de uma chamada HTTP ao Node).
	// Fechar o banco antes das conexões inverteria a ordem e cortaria o drain no
	// meio de um lote — que é exatamente o estado que o `stop_grace_period` do
	// compose existe para cobrir.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("[pagarme] shutdown não limpo: %v", err)
	}
	fechaPool(pool, poolCloseTimeout)
	log.Println("[pagarme] encerrado")
}

// motivoDoDrainDesligado nomeia o elo que faltou na cadeia.
//
// Existe porque o estado oposto é o insidioso: serviço saudável, banco
// respondendo, `/health` 200 e nenhuma confirmação de pagamento — e o operador não
// tem onde olhar. A ordem é a da cadeia de pré-requisitos (banco → store → gate →
// token → credencial) e cada mensagem diz o que fazer, não só o que faltou.
func motivoDoDrainDesligado(pool *sql.DB, store server.InboxStore, gate bool, node *nodeapi.Client, pg *gateway.Client) string {
	switch {
	case pool == nil:
		return "sem banco: este processo booted sem DATABASE_URL utilizável, e sem banco não há o que drenar"
	case store == nil:
		return "sem inbox: o banco connectou mas o store do webhook não foi criado"
	case !gate:
		return "PAGARME_DRAIN desligado"
	case !node.TemToken():
		return "PAGARME_INTERNAL_TOKEN ausente: sem token o backend Node recusaria toda chamada, e cada uma " +
			"ia direto para a DLQ"
	case !pg.TemCredencial():
		return "sem PAGARME_SECRET_KEY: sem credencial a reconciliação não consegue reler o gateway"
	default:
		return "pré-requisitos presentes"
	}
}

// fechaPool devolve as conexões do pool na saída do processo.
//
// Existe porque o `database/sql` não devolve conexão nenhuma sozinho: o que a
// chamada faz é marcar o pool como fechado e fechar as conexões ociosas, e é o
// servidor do Postgres que precisa disso para liberar backend e sessão.
//
// A espera é limitada de propósito, e não por superfluidade: o `Close` do driver
// acontece DENTRO do `Close` do pool, e o do lib/pq escreve no socket — contra um
// banco congelado essa escrita não tem prazo nenhum. Sem teto, fechar o pool seria
// mais um caminho de shutdown pendurado atrás de um banco que não responde, e
// esperar não compra coisa nenhuma: o SO fecha o resto assim que o processo sai.
func fechaPool(pool *sql.DB, timeout time.Duration) {
	if pool == nil {
		return // sem DATABASE_URL, ou Connect falhou: não há o que fechar
	}

	fechou := make(chan struct{})
	go func() {
		defer close(fechou)
		if err := pool.Close(); err != nil {
			log.Printf("[pagarme] pool não fechou limpo: %v", err)
		}
	}()

	select {
	case <-fechou:
	case <-time.After(timeout):
		log.Printf("[pagarme] pool não fechou em %v (banco travado) — saindo mesmo assim", timeout)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func version() string {
	if v := os.Getenv("GIT_SHA"); v != "" {
		return v
	}
	return "dev"
}

// envInt lê um inteiro do ambiente com fallback, e o texto de parse fica no log
// quando o valor não é número — porque um `PAGARME_RECONCILIATION_INTERVAL_MS`
// com typo viraria `NaN` e um ticker que nunca dispara, que é a reconciliação
// silenciosamente desligada.
func envInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		log.Printf("[pagarme] %s=%q não é um inteiro positivo — usando %d", key, raw, fallback)
		return fallback
	}
	return n
}
