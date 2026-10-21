package tenancy

import (
	"testing"
)

// =============================================================================
// Statements — o contexto de LINHA do tenant
//
// Nada aqui fala com Postgres: o que está em jogo é a REJEIÇÃO. Um slug fora
// de forma (ou um tenant sem id) tem que virar erro, nunca um `set_config`
// pela metade — é a barreira contra uma env mal digitada ou uma linha
// corrompida no registry.
//
// No modelo por LINHA (`docs/28-multitenant-row-level.md`) o `search_path`
// deixou de ser o isolamento: todas as lojas moram no MESMO schema (`public`)
// e quem separa uma da outra é a coluna `tenant_id` + a policy de RLS. O
// contexto que o gateway grava na transação é o `app.tenant_id` — o ID (uuid)
// da loja, que é o que a policy compara.
// =============================================================================

func TestStatementsGravaOAppTenantId(t *testing.T) {
	const id = "11111111-2222-3333-4444-555555555555"
	stmts, err := Statements(Tenant{ID: id, Slug: "umami"})
	if err != nil {
		t.Fatalf("Statements devolveu erro para escopo válido: %v", err)
	}
	if len(stmts) != 1 {
		t.Fatalf("Statements devolveu %d instrução(ões), quer 1 (app.tenant_id)", len(stmts))
	}

	// O `app.tenant_id` leva o ID (uuid), não o slug: é o que a policy do
	// Postgres vai comparar com a coluna `tenant_id`.
	if stmts[0].Args[0] != "app.tenant_id" || stmts[0].Args[1] != id {
		t.Errorf("instrução = %v, quer app.tenant_id=%s", stmts[0].Args, id)
	}
}

// O vazio é SEM escopo, e é de propósito: é o modo legado de uma-loja, em que
// nada muda em relação ao contexto da conexão. `Statements` com Tenant{}
// tem que devolver lista vazia (e não um `set_config` vazio, que apontaria
// para lugar nenhum).
func TestStatementsVazioNaoMudaNada(t *testing.T) {
	stmts, err := Statements(Tenant{})
	if err != nil {
		t.Fatalf("Statements devolveu erro para Tenant vazio: %v", err)
	}
	if len(stmts) != 0 {
		t.Errorf("Statements devolveu %d instrução(ões) para Tenant vazio, quer 0", len(stmts))
	}
}

// Fail-closed: forma errada vira ERRO. A lista é o que uma env mal digitada e
// uma linha corrompida no registry tentariam passar.
func TestStatementsRejeitaEscopoInconfiavel(t *testing.T) {
	casos := []struct {
		name   string
		tenant Tenant
	}{
		{"slug com maiúscula", Tenant{ID: DefaultID, Slug: "Umami"}},
		{"slug com espaço", Tenant{ID: DefaultID, Slug: "loja a"}},
		{"slug com ponto (tentativa de escalar)", Tenant{ID: DefaultID, Slug: "../public"}},
		{"tenant sem id (o contexto de linha ficaria vazio)", Tenant{Slug: "umami"}},
	}

	for _, c := range casos {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Statements(c.tenant); err == nil {
				t.Errorf("Statements aceitou %+v — um nome fora de forma passaria", c.tenant)
			}
		})
	}
}

// O contexto de linha é o ID (uuid) da loja. Um id que não é uuid é recusado:
// o `set_config` falharia no meio da transação.
func TestStatementsRecusaIdMalformado(t *testing.T) {
	for _, id := range []string{"nao-e-uuid", "123", "'; DROP TABLE public.tenant; --"} {
		if _, err := Statements(Tenant{ID: id, Slug: "umami"}); err == nil {
			t.Errorf("Statements aceitou o id %q — o set_config falharia no meio da transação", id)
		}
	}
}
