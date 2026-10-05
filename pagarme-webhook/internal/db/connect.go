// Package db abre o pool de conexões com o PostgreSQL.
//
// Espelha `ws-gateway/internal/db`: `database/sql` com o driver `lib/pq`, sem
// pgx e sem sqlx. A escolha do `lib/pq` não é só preferência: é o driver que o
// `ws-gateway` já usa em produção, e trocar de driver entre os dois processos Go
// que apontam para o MESMO banco traria duas semânticas de sslmode, de tipos e
// de erro para o mesmo schema.
package db

import (
	"database/sql"
	"log"
	"time"

	_ "github.com/lib/pq"
)

// Connect abre o pool e confere que o Postgres responde (Ping). Devolve erro, e
// não um pool quebrado, para o chamador decidir: este serviço sobe sem banco de
// propósito (ver cmd/webhook/main.go) — o `/health` degradado é o que impede o
// Caddy de apontar o webhook para uma instância que não grava nada.
//
// ## `?sslmode=disable` é obrigatório no DSN de teste e no default do compose
//
// O `lib/pq` assume `sslmode=require` quando a DSN não diz nada, e o Postgres do
// compose não tem TLS. Sem o parâmetro o `Connect` falha com "pq: SSL is not
// enabled on the server" e o serviço sobe SEM pool — que é silencioso, porque o
// `/health` responde 200 sem banco por decisão (mesmo desenho do gateway WS). Por
// isso o `/health` desta peça degrada sem pool (ao contrário do gateway: aqui não
// existe plano de rollback que dependa deste processo mudo, e um serviço que
// recebe webhook sem gravar é pior do que um serviço fora do ar).
func Connect(dsn string) (*sql.DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}

	db.SetMaxOpenConns(MaxOpenConns)
	db.SetMaxIdleConns(MaxIdleConns)
	db.SetConnMaxLifetime(ConnMaxLifetime)

	log.Println("[db] conexão com o PostgreSQL estabelecida")
	return db, nil
}

// Limites do pool.
//
// Não vêm do ambiente porque o uso é conhecido e pequeno. O número conta as
// posições de CONEXÃO LONGA que este processo tem, que são as que importam:
//
//   - 1 para o drain da inbox, que segura transação + advisory lock durante o
//     lote inteiro — inclusive durante as chamadas HTTP ao backend Node;
//   - 1 para a reconciliação, pelo mesmo motivo;
//   - 2 para o probe de /health (ver internal/server: `maxInFlight`), que são
//     as únicas perguntas que podem ficar presas para sempre;
//   - o resto é folga para os INSERT da inbox, que chegam concentrados no
//     fechamento do expediente e não podem esperar por conexão.
//
// Com 10 há folga para o pico da inbox sem sobra o bastante para segurar
// conexões ociosas. `MaxIdleConns` menor que o máximo é deliberado: o
// comportamento normal é 3-4 conexões, e manter 10 ociosas reteria backend do
// Postgres à toa.
const (
	MaxOpenConns    = 10
	MaxIdleConns    = 4
	ConnMaxLifetime = 30 * time.Minute
)
