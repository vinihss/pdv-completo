// Comando admin: o servidor HTTP de administração do PDV.
//
// Roda no host da aplicação e é consumido pela TUI remota (docs/25). Expõe
// /health sem auth e todo o /admin atrás de um bearer estático + rate limit.
//
// Configuração (ver internal/config):
//
//	PDV_ADMIN_TOKEN         token bearer esperado (obrigatório)
//	PDV_ADMIN_ADDR          bind (default 127.0.0.1:9090)
//	PDV_DATABASE_URL        DSN do Postgres (obrigatório)
//	PDV_REDIS_URL           DSN do Redis (default redis://127.0.0.1:6379)
//	PDV_BACKEND_CONTAINER   container do backend (default deploy-backend-1)
//	PDV_DEPLOY_DIR          diretório com backup.sh (vazio = backup 503)
//	PDV_ADMIN_RATE_PER_MIN  teto por IP (default 120)
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"pdv-admin-server/internal/auth"
	"pdv-admin-server/internal/config"
	"pdv-admin-server/internal/httpapi"
	"pdv-admin-server/internal/pgstore"
	"pdv-admin-server/internal/tenants"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.Println("[admin] iniciando admin-server")

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[admin] configuração inválida: %v", err)
	}

	// ctx cancelado no primeiro SIGINT/SIGTERM: para de aceitar conexão e sai.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := pgstore.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("[admin] não conectou no PostgreSQL: %v", err)
	}
	defer store.Close()

	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("[admin] PDV_REDIS_URL inválido: %v", err)
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close()

	if cfg.DeployDir == "" {
		log.Println("[admin] AVISO: PDV_DEPLOY_DIR vazio — /admin/backup responderá 503 not_configured")
	}

	srv := httpapi.New(httpapi.Deps{
		Tenants:     store,
		Settings:    store,
		Provisioner: tenants.NewService(cfg.BackendContainer),
		Cache:       &redisFlusher{client: rdb},
		Backup:      tenants.NewBackupService(cfg.DeployDir),
		Version:     cfg.Version,
		Started:     time.Now(),
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", srv.HealthHandler())
	// O rate é por minuto no ambiente; o limiter trabalha por segundo.
	admin := auth.Middleware(cfg.Token, float64(cfg.RatePerMin)/60.0, cfg.RatePerMin, srv.AdminHandler())
	mux.Handle("/admin/", admin)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[admin] escutando em %s", cfg.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[admin] falha no listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("[admin] shutdown pedido")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("[admin] shutdown não limpo: %v", err)
	}
	log.Println("[admin] encerrado")
}

// redisFlusher implementa httpapi.CacheFlusher sobre o cliente go-redis.
type redisFlusher struct {
	client *redis.Client
}

func (f *redisFlusher) Flush(ctx context.Context) error {
	return f.client.FlushDB(ctx).Err()
}
