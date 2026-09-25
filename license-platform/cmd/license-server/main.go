// Command license-server sobe o servidor HTTP de emissão e validação
// de licenças.
//
// Este arquivo é, por decisão arquitetural (ver documento de decisões,
// ADR-07), o único ponto do sistema que conhece todas as implementações
// concretas das portas do domínio: aqui e só aqui GORM, SQLite e o
// KeyProvider em memória são instanciados e injetados. Nenhum outro
// pacote do projeto deveria importar gorm, o driver sqlite, ou
// crypto/ed25519 fora de internal/crypto.
package main

import (
	"context"
	"encoding/base64"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"github.com/example/license-platform/internal/api"
	"github.com/example/license-platform/internal/crypto"
	"github.com/example/license-platform/internal/license"
	"github.com/example/license-platform/internal/repository"
)

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags)
	cfg := loadConfig()

	if err := ensureDatabaseDir(cfg.DatabasePath); err != nil {
		logger.Fatalf("preparando diretório do banco: %v", err)
	}

	db, err := gorm.Open(sqlite.Open(cfg.DatabasePath), &gorm.Config{})
	if err != nil {
		logger.Fatalf("abrindo banco de dados: %v", err)
	}

	repo := repository.NewGorm(db)
	if err := repo.AutoMigrate(); err != nil {
		logger.Fatalf("executando automigrate: %v", err)
	}

	// ATENÇÃO (MVP): chave gerada em memória a cada boot. Ver
	// internal/crypto/keyprovider.go para o plano de evolução para
	// secret manager / HSM antes de produção.
	keys, err := crypto.NewInMemoryKeyProvider(cfg.KeyID)
	if err != nil {
		logger.Fatalf("gerando par de chaves: %v", err)
	}
	signer := crypto.NewEd25519Signer(keys)
	clock := license.RealClock{}

	issueService := license.NewIssueService(repo, signer, clock)
	validateService := license.NewValidateService(repo, signer, clock)

	handler := api.NewHandler(issueService, validateService, logger)

	pub, keyID, err := keys.PublicKey(context.Background())
	if err != nil {
		logger.Fatalf("lendo chave pública: %v", err)
	}
	logger.Printf("chave em uso — key_id: %s", keyID)
	logger.Printf("chave pública (base64): %s", base64.StdEncoding.EncodeToString(pub))
	logger.Printf("MVP: esta chave é gerada em memória e muda a cada reinicialização — não usar em produção")

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Printf("servidor ouvindo em %s", cfg.HTTPAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("erro no servidor HTTP: %v", err)
		}
	}()

	waitForShutdown(server, logger)
}

// ensureDatabaseDir cria o diretório pai do arquivo SQLite, se ainda
// não existir, com permissão restrita ao usuário do processo.
func ensureDatabaseDir(databasePath string) error {
	dir := filepath.Dir(databasePath)
	if dir == "." || dir == "" {
		return nil
	}
	return os.MkdirAll(dir, 0o700)
}

// waitForShutdown bloqueia até um sinal de interrupção e então encerra
// o servidor HTTP de forma graciosa, com um prazo máximo.
func waitForShutdown(server *http.Server, logger *log.Logger) {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Println("encerrando servidor...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Printf("erro ao encerrar servidor de forma graciosa: %v", err)
	}
}
