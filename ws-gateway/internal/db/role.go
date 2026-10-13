package db

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
)

// Auditoria de papel da conexão.
//
// ## Por que isto existe
//
// O isolamento do multi-tenant é o `search_path` da conexão/da transação, e
// `search_path` não depende de papel nenhum — o sistema funciona com a role que
// for. O que o papel decide é se a OUTRA barreira, a RLS, está viva: medido em
// produção (docs/15-multi-tenant-schema.md §2), a role `pdv` conecta como
// **superuser** (`rolsuper=t`, `rolbypassrls=t`), e superuser sempre bypassa row
// security, inclusive com `FORCE ROW LEVEL SECURITY` em cada tabela.
//
// Ou seja: quando a Fase 4 daquele doc ligar RLS, ela daria sensação de
// isolamento sem barreira nenhuma — o modo de falha que o histórico do projeto
// já pagou uma vez. Este audit é o que faz isso aparecer no log do boot em vez
// de só no dia em que alguém confiar em RLS.
//
// ## Por que só AUDITA, e não conserta
//
// Trocar a role do DSN é DDL/GRANT fora do alcance deste serviço (criar
// `pdv_app`, dar USAGE nos schemas de tenant, revogar o superuser da role que o
// app usa) e é decisão de operação, não de código: por isso está registrado
// como pendência e não executado aqui. O serviço lê a realidade e relata.
//
// `DB_REQUIRE_RESTRICTED=1` transforma o aviso em recusa de subir (default-deny,
// a mesma regra de parse do `WS_DISPATCH`). Ele existe para o deploy que já
// migrou a role: sem ele, o esquecimento de tirar `superuser` do DSN passaria
// batido no log.
const requireRestrictedEnv = "DB_REQUIRE_RESTRICTED"

// vereditoPapel é o resultado puro da auditoria — puro de propósito, para o
// teste cobrir os quatro casos sem precisar de Postgres nem de roles reais.
type vereditoPapel struct {
	// Restrito diz se a papel NÃO tem superuser nem BYPASSRLS: é a condição em
	// que RLS, um dia, valeria alguma coisa.
	Restrito bool
	// Motivo nomeia o que falta (`superuser`, `BYPASSRLS`, ou os dois). Vazio
	// quando restrito.
	Motivo string
}

// avaliaPapel aplica a regra. `rolsuper` e `rolbypassrls` vêm de
// `pg_roles WHERE rolname = current_user`.
func avaliaPapel(rolsuper, rolbypassrls bool) vereditoPapel {
	var motivos []string
	if rolsuper {
		motivos = append(motivos, "superuser")
	}
	if rolbypassrls {
		motivos = append(motivos, "BYPASSRLS")
	}
	if len(motivos) == 0 {
		return vereditoPapel{Restrito: true}
	}
	return vereditoPapel{Motivo: strings.Join(motivos, " + ")}
}

// exigePapelRestrito lê a env de recusa. Default-deny: só `1/true/yes/on`
// ligam, o MESMO parse do `WS_DISPATCH` (ver internal/outbox/gate.go) — valor
// mal digitado não pode nem ligar nem DESLIGAR uma garantia.
func exigePapelRestrito() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(requireRestrictedEnv))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// auditaPapel consulta o papel da conexão recém-aberta e aplica a política:
// loga o veredito, e recusa o pool quando a env exige papel restrito e o papel
// não é.
//
// O resultado é ligado ao pool logo após o Ping, dentro de `Connect`, porque é
// o único momento em que "o boot falhou" é uma resposta clara para o operador —
// um aviso impresso durante o primeiro ciclo de outbox a cada 200ms seria ruído,
// e um aviso impresso uma vez só é lido no dia em que alguém vai ao log.
//
// Se a própria consulta falhar (role sem SELECT em `pg_roles` — não é o caso
// hoje: o catálogo é legível por qualquer role), o audit NÃO derruba o boot: o
// serviço é útil sem RLS e sem esta informação. O log diz que não sabe.
func auditaPapel(db *sql.DB) error {
	var papel string
	var veredito vereditoPapel
	var rolsuper, rolbypassrls bool

	err := db.QueryRow(`SELECT current_user, rolsuper, rolbypassrls
		FROM pg_roles WHERE rolname = current_user`).
		Scan(&papel, &rolsuper, &rolbypassrls)
	if err != nil {
		log.Printf("[db] AVISO: não consegui auditar o papel da conexão (%v) — sem essa leitura, ninguém "+
			"saberia se RLS estaria inerte (docs/15 §2)", err)
		return nil
	}

	veredito = avaliaPapel(rolsuper, rolbypassrls)
	if veredito.Restrito {
		log.Printf("[db] papel da conexão %q é restrito (sem superuser nem BYPASSRLS)", papel)
		return nil
	}

	if exigePapelRestrito() {
		return fmt.Errorf("%s=%s ligado e o papel da conexão %q não é restrito (%s): "+
			"RLS seria inerte com esta role (docs/15-multi-tenant-schema.md §2) — troque a role do DSN ou desligue a env",
			requireRestrictedEnv, os.Getenv(requireRestrictedEnv), papel, veredito.Motivo)
	}

	log.Printf("[db] AVISO: papel da conexão NÃO é restrito (%s) — RLS seria INERTE com esta role, "+
		"inclusive com FORCE ROW LEVEL SECURITY (medido em produção: docs/15-multi-tenant-schema.md §2). "+
		"O isolamento de hoje é o search_path, que não depende de papel; para exigir papel restrito no boot, "+
		"liga %s=1.", veredito.Motivo, requireRestrictedEnv)
	return nil
}
