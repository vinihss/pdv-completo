package tenancy

import (
	"context"
	"strings"
	"testing"
)

// =============================================================================
// Statements / SearchPath — a barreira que vale HOJE
//
// Nada aqui fala com Postgres: o que está em jogo é a REJEIÇÃO. Um slug ou um
// schema fora de forma tem que virar erro, nunca `search_path` — é a segunda
// barreira (depois do CHECK do banco) contra uma env mal digitada apontando a
// leitura de outbox para o schema errado. Um teste que só exercitasse o caminho
// feliz deixaria esse defeito passando.
// =============================================================================

func TestStatementsPoeOSDoisConfigs(t *testing.T) {
	stmts, err := Statements(Tenant{Slug: "umami", Schema: "tenant_umami"})
	if err != nil {
		t.Fatalf("Statements devolveu erro para escopo válido: %v", err)
	}
	if len(stmts) != 2 {
		t.Fatalf("Statements devolveu %d instrução(ões), quer 2 (app.tenant_id + search_path)", len(stmts))
	}

	if stmts[0].Args[0] != "app.tenant_id" || stmts[0].Args[1] != "umami" {
		t.Errorf("primeira instrução = %v, quer app.tenant_id=umami", stmts[0].Args)
	}
	if stmts[1].Args[0] != "search_path" || stmts[1].Args[1] != "tenant_umami, public" {
		t.Errorf("segunda instrução = %v, quer search_path='tenant_umami, public'", stmts[1].Args)
	}
}

// O vazio é SEM escopo, e é de propósito: é o modo legado de uma-loja, em que
// nada muda em relação ao search_path da conexão. `Statements` com Tenant{}
// tem que devolver lista vazia (e não um SET de search_path vazio, que apontaria
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
		{"slug com maiúscula", Tenant{Slug: "Umami", Schema: "tenant_umami"}},
		{"slug com espaço", Tenant{Slug: "loja a", Schema: "tenant_loja_a"}},
		{"slug com ponto (tentativa de escalar)", Tenant{Slug: "../public", Schema: "tenant_x"}},
		{"schema com ponto", Tenant{Slug: "umami", Schema: "tenant.umami"}},
		{"schema com aspas", Tenant{Slug: "umami", Schema: `"public"`}},
		{"schema com vírgula e trava", Tenant{Slug: "umami", Schema: "public, pg_catalog"}},
		{"só schema inseguro", Tenant{Slug: "", Schema: "1tenant"}},
	}

	for _, c := range casos {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Statements(c.tenant); err == nil {
				t.Errorf("Statements aceitou %+v — um nome fora de forma viraria search_path", c.tenant)
			}
		})
	}
}

// O schema do AMBIENTE é mais frouxo que o do registry de propósito (`public`
// não casa `^tenant_…`), mas continua sem ponto e sem aspas. É a MESMA regra do
// `SAFE_SCHEMA_NAME_PATTERN` do backend (`domain/tenant.ts`) — as duas
// barreiras precisam casar, senão o Node aceita uma env que o gateway recusa (e
// aí um serviço lê um schema que o outro não enxerga).
//
// `information_schema` passa, e é isso mesmo: é identificador seguro, não é
// injeção, e o schema errado falha ALTO (`relation "outbox_event" does not
// exist` a cada ciclo) em vez de ler dado de loja alheia.
func TestStatementsAceitaSchemaDoAmbiente(t *testing.T) {
	seguros := []string{"public", "tenant_main", "tenant_loja_norte_2", "information_schema"}
	for _, schema := range seguros {
		if _, err := Statements(Tenant{Slug: "default", Schema: schema}); err != nil {
			t.Errorf("Statements rejeitou %q: %v", schema, err)
		}
	}
}

// Mesmo formato do pool dedicado do Node (`-c search_path=<schema>,public`):
// o `public` tem que continuar no fim do caminho, senão o registry (que mora
// em `public`) some da resolução.
func TestSearchPath(t *testing.T) {
	casos := []struct{ schema, want string }{
		{"public", "public"},
		{"tenant_umami", "tenant_umami, public"},
		{"tenant_loja_norte_2", "tenant_loja_norte_2, public"},
	}
	for _, c := range casos {
		if got := SearchPath(c.schema); got != c.want {
			t.Errorf("SearchPath(%q) = %q, quer %q", c.schema, got, c.want)
		}
	}
}

// =============================================================================
// Default — a env que os DOIS lados leem
// =============================================================================

// Se o Node gravar o outbox do default em `tenant_main` e o gateway ler
// `public`, o evento é silenciosamente mudo. Por isso a MESMA env, com o MESMO
// fallback `public`.
func TestDefaultUsaAmbienteComMesmoFallbackDoNode(t *testing.T) {
	casos := []struct {
		env  string
		want string
	}{
		{"", "public"},                 // ausente ⇒ public (fallback do Node)
		{"tenant_main", "tenant_main"}, // presente e segura ⇒ usado
		{"public", "public"},
		{"TenantMain", "public"},          // maiúscula não é identificador seguro
		{"tenant.main", "public"},         // ponto abriria caminho de schema
		{"tenant_main, public", "public"}, // vírgula não passa
	}

	for _, c := range casos {
		t.Run("env="+c.env, func(t *testing.T) {
			t.Setenv("DEFAULT_TENANT_SCHEMA", c.env)
			if got := Default().Schema; got != c.want {
				t.Errorf("Default().Schema = %q, quer %q", got, c.want)
			}
			if Default().Slug != DefaultSlug {
				t.Errorf("Default().Slug = %q, quer %q (é o claim do JWT do Node)", Default().Slug, DefaultSlug)
			}
		})
	}
}

// =============================================================================
// WS_TENANTS — a fonte explícita
// =============================================================================

func TestFromEnvLeListaExplicita(t *testing.T) {
	t.Setenv(EnvTenants, "default=public, umami=tenant_umami ,norte=tenant_norte")

	fonte, definida, err := FromEnv()
	if err != nil {
		t.Fatalf("FromEnv devolveu erro para lista válida: %v", err)
	}
	if !definida {
		t.Fatal("FromEnv disse que a env não estava definida com a env preenchida")
	}

	tenants, err := fonte.Tenants(context.Background())
	if err != nil {
		t.Fatalf("Tenants devolveu erro: %v", err)
	}
	porSlug := map[string]string{}
	for _, tenant := range tenants {
		porSlug[tenant.Slug] = tenant.Schema
	}
	for _, esperado := range []struct{ slug, schema string }{
		{"default", "public"},
		{"umami", "tenant_umami"},
		{"norte", "tenant_norte"},
	} {
		if got := porSlug[esperado.slug]; got != esperado.schema {
			t.Errorf("tenant %q com schema %q, quer %q (slugs: %v)", esperado.slug, got, esperado.schema, porSlug)
		}
	}
}

// Um item fora do formato não pode virar "meia lista" — seria o dispatcher
// varrendo um schema e não outro, sem erro nenhum no boot.
func TestFromEnvRejeitaItemForaDoFormato(t *testing.T) {
	casos := []string{
		"umami",                   // sem `=`
		"umami=",                  // sem schema
		"umami=tenant.umami",      // schema com ponto
		"Umami=tenant_umami",      // slug com maiúscula
		"umami=tenant_umami=x",    // dois `=`
		"umami=DROP TABLE tenant", // nem passa perto de identificador
	}

	for _, raw := range casos {
		t.Run(raw, func(t *testing.T) {
			t.Setenv(EnvTenants, raw)
			if _, _, err := FromEnv(); err == nil {
				t.Errorf("FromEnv aceitou %q — a lista errada viraria leitura de schema errado", raw)
			}
		})
	}
}

// Ausente não é lista vazia: é "sem fonte explícita", e o chamador decide (registry
// em produção, só default em dev). Em branco cai no mesmo caso — `WS_TENANTS=" "`
// é esquecimento de editor, não uma lista de um tenant vazio (que seria o
// dispatcher varrendo nada).
func TestFromEnvAusenteNaoEReErro(t *testing.T) {
	for _, raw := range []string{"", "   "} {
		t.Run("env="+raw, func(t *testing.T) {
			t.Setenv(EnvTenants, raw)
			fonte, definida, err := FromEnv()
			if err != nil {
				t.Fatalf("env em branco e FromEnv devolveu erro: %v", err)
			}
			if definida || fonte != nil {
				t.Errorf("env em branco devolveu (fonte=%v, definida=%v), quer (nil, false)", fonte, definida)
			}
		})
	}
}

// =============================================================================
// Static: resolução de Host
// =============================================================================

// O default é acrescentado porque ele existe mesmo sem registry (docs/15 §6.2)
// e é o slug que o JWT do Node traz para a loja default.
func TestNewStaticAcrescentaDefault(t *testing.T) {
	fonte := NewStatic([]Tenant{{Slug: "umami", Schema: "tenant_umami"}})
	tenants, _ := fonte.Tenants(context.Background())

	achouDefault := false
	for _, tenant := range tenants {
		if tenant.Slug == DefaultSlug {
			achouDefault = true
		}
	}
	if !achouDefault {
		t.Errorf("NewStatic sem o default devolveu %v — o claim do JWT da loja default não casaria nada", tenants)
	}
}

// Um `default` EXPLICITADO tem que prevalecer sobre o injetado: a partir do
// cutover a linha do registry é a fonte da verdade (docs/15 §6.2).
func TestNewStaticRespeitaDefaultExplicito(t *testing.T) {
	fonte := NewStatic([]Tenant{{Slug: DefaultSlug, Schema: "tenant_main"}})
	tenants, _ := fonte.Tenants(context.Background())

	var vistos []string
	for _, tenant := range tenants {
		if tenant.Slug == DefaultSlug {
			vistos = append(vistos, tenant.Schema)
		}
	}
	if len(vistos) != 1 || vistos[0] != "tenant_main" {
		t.Errorf("slugs default = %v, quer exatamente [tenant_main]", vistos)
	}
}

// As regras de Host do Node (§3.1 do doc 15), na forma que o caminho público do
// gateway precisa. Sem esta ponte, a vitrine de uma loja entraria no escopo do
// default e ficaria muda.
func TestResolveHost(t *testing.T) {
	fonte := NewStatic([]Tenant{
		{Slug: "umami", Schema: "tenant_umami"},
		{Slug: "norte", Schema: "tenant_norte"},
	})

	casos := []struct {
		host string
		want string
	}{
		{"umami.pdv.app", "umami"},     // subdomínio de slug conhecido
		{"UMAMI.PDV.APP", "umami"},     // case-insensitive
		{"umami.pdv.app:443", "umami"}, // porta removida
		{"norte.pdv.app", "norte"},
		{"desconhecido.pdv.app", DefaultSlug}, // slug que não existe ⇒ default
		{"localhost", DefaultSlug},            // 1 rótulo
		{"localhost:8080", DefaultSlug},
		{"loja.localhost", DefaultSlug}, // `.localhost` é loopback
		{"www.pdv.app", DefaultSlug},    // rótulo reservado
		{"app.pdv.app", DefaultSlug},    // rótulo reservado
		{"api.pdv.app", DefaultSlug},    // rótulo reservado
		{"pdv.app", DefaultSlug},        // apex
		{"", DefaultSlug},               // sem host
		{"::1", DefaultSlug},            // IPv6 sem colchetes não é host
		{"[::1]:8080", DefaultSlug},     // literal IPv6 ⇒ 1 rótulo ⇒ default
	}

	for _, c := range casos {
		t.Run(c.host, func(t *testing.T) {
			got, err := fonte.Resolve(context.Background(), c.host)
			if err != nil {
				t.Fatalf("Resolve devolveu erro: %v", err)
			}
			if got.Slug != c.want {
				t.Errorf("Resolve(%q) = %q, quer %q", c.host, got.Slug, c.want)
			}
		})
	}
}

// O schema do tenant resolvido é o que o dispatcher vai varrer: resolver o slug
// certo com schema vazio seria o ciclo lendo o schema da conexão.
func TestResolveHostDevolveSchema(t *testing.T) {
	fonte := NewStatic([]Tenant{{Slug: "umami", Schema: "tenant_umami"}})

	got, err := fonte.Resolve(context.Background(), "umami.pdv.app")
	if err != nil {
		t.Fatalf("Resolve devolveu erro: %v", err)
	}
	if got.Schema != "tenant_umami" {
		t.Errorf("Resolve devolveu schema %q, quer tenant_umami", got.Schema)
	}
}

// =============================================================================
// NormalizeHost — a parte pura
// =============================================================================

func TestNormalizeHost(t *testing.T) {
	casos := []struct {
		raw  string
		want string
		ok   bool
	}{
		{"Loja.PDV.App", "loja.pdv.app", true},
		{" loja.pdv.app ", "loja.pdv.app", true},
		{"loja.pdv.app:8080", "loja.pdv.app", true},
		{"loja.pdv.app.", "loja.pdv.app", true}, // ponto final da DNS
		{"[::1]:8080", "::1", true},
		{"", "", false},
		{"   ", "", false},
		{"loja..app", "", false}, // rótulo vazio
		{"loja app", "", false},  // espaço
		{"loja/pdv", "", false},  // barra: tentativa de caminho
		{"loja;pdv", "", false},
		{"[::1", "", false},                   // colchete aberto sem fechar
		{"[abc]", "", false},                  // entre colchetes mas não é IPv6
		{"[::1]junk", "", false},              // lixo depois do colchete que não é porta
		{strings.Repeat("a", 254), "", false}, // acima do tamanho de um nome
	}

	for _, c := range casos {
		t.Run(c.raw, func(t *testing.T) {
			got, ok := NormalizeHost(c.raw)
			if ok != c.ok || got != c.want {
				t.Errorf("NormalizeHost(%q) = (%q, %v), quer (%q, %v)", c.raw, got, ok, c.want, c.ok)
			}
		})
	}
}
