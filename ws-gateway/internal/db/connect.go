package db

import (
	"database/sql"
	"log"
	"time"

	_ "github.com/lib/pq"
)

// Connect abre o pool de conexões com o PostgreSQL e confere que ele responde
// (Ping). Devolve erro, e não um pool quebrado, para o chamador decidir: o
// gateway sobe sem banco de propósito (ver cmd/gateway/main.go).
//
// Os limites do pool são fixos e não vêm do ambiente: o uso é conhecido — um
// dispatcher serial, que segura UMA conexão durante o lote inteiro do outbox
// (transação + advisory lock, ver internal/outbox). O número é o teto que o
// binário precisa, não um número para tunar por ambiente.
func Connect(dsn string) (*sql.DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}

	err = db.Ping()
	if err != nil {
		db.Close()
		return nil, err
	}

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)

	log.Println("[db] conexão com o PostgreSQL estabelecida")
	return db, nil
}
