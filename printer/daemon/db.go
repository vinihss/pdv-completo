package main

import (
	"database/sql"
	"embed"
	"fmt"
	"log"

	// Driver SQLite puro Go, sem CGO: é o que permite cross-compilar o daemon
	// para Windows a partir de Linux. O import em branco é o que registra o
	// driver — sem ele `sql.Open("sqlite", ...)` devolve "unknown driver", e é
	// também o que mantém modernc.org/sqlite como dependência direta depois de
	// um `go mod tidy` (nada mais no pacote o importa).
	_ "modernc.org/sqlite"
)

// O baseline do cupom vive dentro do binário: o daemon precisa subir mesmo sem
// um diretório de templates no disco, porque sem ele a instalação pela metade
// (ou um antivírus limpando a pasta) deixaria o PDV sem impressão nenhuma.
//
//go:embed templates/*.json
var embeddedTemplates embed.FS

// migrate aplica o schema final. Roda em toda subida, então precisa ser
// idempotente sobre banco novo e sobre banco de uma versão anterior: o padrão
// é `CREATE TABLE IF NOT EXISTS` para o que não existe e `ALTER TABLE ADD
// COLUMN` com o erro ignorado para o que já existe.
func migrate(db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS print_jobs (
			id TEXT PRIMARY KEY,
			order_id TEXT NOT NULL,
			destination TEXT NOT NULL,
			printer_id TEXT,
			payload_json TEXT NOT NULL,
			payload_hash TEXT,
			template_id TEXT NOT NULL,
			template_version INTEGER NOT NULL,
			status TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			next_attempt_at TEXT,
			blocked_reason TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(order_id, destination)
		)`,
		`CREATE TABLE IF NOT EXISTS external_events (
			external_event_id TEXT NOT NULL,
			destination TEXT NOT NULL,
			job_id TEXT,
			status TEXT NOT NULL,
			error TEXT,
			received_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			reported_status TEXT,
			UNIQUE(external_event_id, destination)
		)`,
		`CREATE TABLE IF NOT EXISTS cloud_state (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return fmt.Errorf("criar tabelas: %w", err)
		}
	}

	// Colunas introduzidas depois da primeira versão do esquema. O erro é
	// propositalmente ignorado: a única razão de o ADD COLUMN falhar aqui é a
	// coluna já existir, e isso é o caso normal a partir da segunda subida.
	// `printer_id` e `blocked_reason` são o que permite segurar um job quando a
	// impressora some; `payload_hash` é o que distingue reenvio de conflito.
	columns := []string{
		`ALTER TABLE print_jobs ADD COLUMN next_attempt_at TEXT`,
		`ALTER TABLE print_jobs ADD COLUMN printer_id TEXT`,
		`ALTER TABLE print_jobs ADD COLUMN payload_hash TEXT`,
		`ALTER TABLE print_jobs ADD COLUMN blocked_reason TEXT`,
		`ALTER TABLE external_events ADD COLUMN reported_status TEXT`,
	}
	for _, column := range columns {
		if _, err := db.Exec(column); err != nil {
			// Ruído esperado a partir da segunda subida: a coluna já está lá.
			log.Printf("migrate: %s já existe (esperado)", column)
		}
	}

	// Backfill do status já conhecido de cada evento. Sem isso, um banco que
	// existia antes da coluna reported_status tem todas as linhas com NULL e
	// reportPendingStatuses reenvia o histórico inteiro para a nuvem na primeira
	// subida da nova versão.
	//
	// O `WHERE reported_status IS NULL` é obrigatório e não é cosmético: sem
	// ele a segunda execução sobrescreve o que já foi reportado e a nuvem recebe
	// o mesmo status de novo, a cada boot, para sempre.
	//
	// Deliberadamente sem índice em reported_status: o teste de migração faz
	// `ALTER TABLE external_events DROP COLUMN reported_status`, e o SQLite
	// recusa dropar uma coluna indexada.
	if _, err := db.Exec(`UPDATE external_events SET reported_status = COALESCE((SELECT status FROM print_jobs WHERE print_jobs.id = external_events.job_id), status) WHERE reported_status IS NULL`); err != nil {
		return fmt.Errorf("backfill de reported_status: %w", err)
	}
	return nil
}
