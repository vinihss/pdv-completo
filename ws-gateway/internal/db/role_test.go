package db

import "testing"

// A auditoria de papel é a única parte do connect que dá para provar sem
// Postgres: a regra pura (superuser/BYPASSRLS ⇒ não restrito) e o parse da env.
// O que não dá para prover aqui é o SELECT em `pg_roles` — isso é coberto pelo
// boot real, e a dúvida que restaria (a query existe e lê os campos certos) é a
// mesma que o log do primeiro boot responde.
func TestAvaliaPapel(t *testing.T) {
	casos := []struct {
		name         string
		rolsuper     bool
		rolbypassrls bool
		restrito     bool
		motivo       string
	}{
		{name: "role comum", rolsuper: false, rolbypassrls: false, restrito: true, motivo: ""},
		{name: "superuser", rolsuper: true, rolbypassrls: false, restrito: false, motivo: "superuser"},
		{name: "bypassrls", rolsuper: false, rolbypassrls: true, restrito: false, motivo: "BYPASSRLS"},
		// O caso medido em produção (docs/15 §2): `pdv | t | t`.
		{name: "superuser + bypassrls", rolsuper: true, rolbypassrls: true, restrito: false, motivo: "superuser + BYPASSRLS"},
	}

	for _, c := range casos {
		t.Run(c.name, func(t *testing.T) {
			got := avaliaPapel(c.rolsuper, c.rolbypassrls)
			if got.Restrito != c.restrito {
				t.Errorf("avaliaPapel(%v, %v).Restrito = %v, quer %v",
					c.rolsuper, c.rolbypassrls, got.Restrito, c.restrito)
			}
			if got.Motivo != c.motivo {
				t.Errorf("avaliaPapel(%v, %v).Motivo = %q, quer %q",
					c.rolsuper, c.rolbypassrls, got.Motivo, c.motivo)
			}
		})
	}
}

// Default-deny, o mesmo parse do `WS_DISPATCH`: um valor mal digitado não pode
// nem LIGAR uma garantia (aqui: recusar o boot) nem, o caso mais perigoso,
// DESLIGAR a recusa que alguém configurou achando que ligou.
func TestExigePapelRestritoDefaultDeny(t *testing.T) {
	casos := []struct {
		raw  string
		want bool
	}{
		{"", false},
		{"0", false},
		{"false", false},
		{"no", false},
		{"off", false},
		{"sim", false}, // não é um valor de ligado do serviço
		{"2", false},
		{"ligado", false},
		{"1", true},
		{"true", true},
		{"TRUE", true},
		{"yes", true},
		{"on", true},
		{" 1 ", true},
	}

	for _, c := range casos {
		t.Run(c.raw, func(t *testing.T) {
			t.Setenv(requireRestrictedEnv, c.raw)
			if got := exigePapelRestrito(); got != c.want {
				t.Errorf("%s=%q ⇒ %v, quer %v", requireRestrictedEnv, c.raw, got, c.want)
			}
		})
	}
}
