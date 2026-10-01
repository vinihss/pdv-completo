package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	// 1. Argumentos de linha de comandos
	configFile := flag.String("config", "config.json", "Caminho para o ficheiro de configuração")
	port := flag.Int("port", 8080, "Porta do servidor de impressão local")
	flag.Parse()

	log.Printf("[MAIN] A iniciar PDV Print Daemon v%s...\n", CurrentVersion)

	// 2. Inicializar Fila Persistente (Spooler Offline-First com BoltDB)
	spooler, err := NewSpooler("spooler.db")
	if err != nil {
		log.Fatalf("[CRITICAL] Erro ao iniciar base de dados da fila local: %v\n", err)
	}
	defer spooler.Close()
	log.Println("[SPOOLER] Fila local persistente inicializada com sucesso.")

	// 3. Inicializar a Camada de Transporte de Impressão (Network/CUPS/Windows Spooler)
	transport := NewTransport()
	log.Println("[TRANSPORT] Camada de transporte física carregada.")

	// 4. Iniciar o Trabalhador em Background para Consumir a Fila
	go spooler.ProcessQueue(transport)
	log.Println("[WORKER] Processador de fila de impressão iniciado em segundo plano.")

	// 5. Iniciar Rotina de Auto-Update em Background
	go func() {
		// Aguarda 1 minuto após a inicialização para não sobrecarregar o boot do sistema
		time.Sleep(1 * time.Minute)

		log.Println("[UPDATER] Serviço de verificação de atualizações ativo.")
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()

		for {
			if err := CheckAndApplyUpdate(); err != nil {
				log.Printf("[UPDATER] Erro durante a verificação de atualização: %v\n", err)
			}
			<-ticker.C
		}
	}()

	// 6. Configurar Rotas da API HTTP Local
	mux := http.NewServeMux()

	// Endpoint de Saúde/Healthcheck
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"online","version":"%s"}`, CurrentVersion)
	})

	// Endpoint para Ingestão de Impressões
	mux.HandleFunc("/print", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Método não permitido", http.StatusMethodNotAllowed)
			return
		}

		// Exemplo de recepção de pedido e colocação na fila persistente
		job := PrintJob{
			ID:        fmt.Sprintf("job-%d", time.Now().UnixNano()),
			Printer:   r.URL.Query().Get("printer"),
			Retries:   0,
			CreatedAt: time.Now(),
		}

		// Se a impressora não for especificada, usa a padrão
		if job.Printer == "" {
			job.Printer = "default"
		}

		// Enfileira o trabalho de forma segura no BoltDB
		if err := spooler.EnqueueJob(job); err != nil {
			log.Printf("[API] Erro ao colocar pedido na fila: %v\n", err)
			http.Error(w, "Erro ao gravar pedido na fila local", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprintf(w, `{"status":"queued","job_id":"%s"}`, job.ID)
	})

	// 7. Servidor HTTP com Encerramento Suave (Graceful Shutdown)
	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", *port),
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	// Canal para capturar sinais de interrupção do SO (SIGINT, SIGTERM)
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("[SERVER] Servidor de impressão escutando na porta %d...\n", *port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[CRITICAL] Erro no servidor HTTP: %v\n", err)
		}
	}()

	// Aguardar sinal de desligamento
	<-stopChan
	log.Println("[MAIN] Sinal de encerramento recebido. A fechar conexões...")

	// Timeout para encerrar requisições pendentes
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("[MAIN] Erro ao encerrar servidor HTTP: %v\n", err)
	}

	log.Println("[MAIN] Daemon encerrado com sucesso.")
}
