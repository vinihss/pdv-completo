package tenancy

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"pdv-ws-gateway/internal/db"
)

// =============================================================================
// Registry de verdade (pula sem WS_GATEWAY_TEST_DATABASE_URL)
//
// O que só um Postgres prova aqui: a fonte de tenants é o MESMO catálogo que o
// Node lê (`public.tenant`), com o mesmo filtro de status, e é ela que diz o
// schema de cada ciclo do outbox — um `schema_name` lido errado é o evento de
// uma loja saindo do schema de outra.
// =============================================================================

// criarTenantTable espelha `backend/migrations/registry/0001_tenant_registry.sql`
// (só o que a suíte usa). `IF NOT EXISTS` de propósito: num banco que já roda o
// registry de verdade, quem manda é a DDL real.
// A tabela do registry no modelo por LINHA (`docs/28`): sem `schema_name` (a
// coluna saiu na migration `0018`).
const criarTenantTable = `CREATE TABLE IF NOT EXISTS public.tenant (
	id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	slug         TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
	display_name TEXT NOT NULL,
	status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
	custom_domain TEXT,
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)`

func testDB(t *testing.T) *sql.DB {
	t.Helper()

	dsn := os.Getenv("WS_GATEWAY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("WS_GATEWAY_TEST_DATABASE_URL não definida: suíte do registry pulada")
	}
	pool, err := db.Connect(dsn)
	if err != nil {
		t.Skipf("Postgres de teste não respondeu (%v): suíte do registry pulada", err)
	}
	t.Cleanup(func() { pool.Close() })

	if _, err := pool.Exec(criarTenantTable); err != nil {
		t.Fatalf("não consegui garantir a tabela public.tenant no banco de teste: %v", err)
	}
	return pool
}

// novoTenantDeTeste grava um tenant ativo e devolve (slug, id, domínio
// próprio) com sufixo aleatório: a suíte não apaga o que é de outro teste, então
// cada rodada só fala das linhas que plantou. O cleanup remove as três.
func novoTenantDeTeste(t *testing.T, pool *sql.DB, status string) (slug, id, dominio string) {
	t.Helper()

	var sufixo [4]byte
	if _, err := rand.Read(sufixo[:]); err != nil {
		t.Fatalf("rand falhou: %v", err)
	}
	hexSufixo := hex.EncodeToString(sufixo[:])
	slug = "loja-" + hexSufixo
	dominio = hexSufixo + ".exemplo.test"

	var tenantID string
	if err := pool.QueryRow(
		`INSERT INTO public.tenant (slug, display_name, status, custom_domain)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		slug, "Loja de teste "+hexSufixo, status, dominio).Scan(&tenantID); err != nil {
		t.Fatalf("não consegui plantar o tenant de teste: %v", err)
	}
	id = tenantID
	t.Cleanup(func() {
		if _, err := pool.Exec(`DELETE FROM public.tenant WHERE slug = $1`, slug); err != nil {
			t.Errorf("não consegui limpar o tenant de teste %s: %v", slug, err)
		}
	})
	return slug, id, dominio
}

// O registry é a fonte do dispatcher: ativos entram com o schema certo, o
// suspensO não entra, e o default está lá mesmo sem linha (docs/15 §6.2 — ele
// só deixa de ser injetado quando virar linha do registry).
func TestRegistryLeAtivosESaltaSuspensos(t *testing.T) {
	pool := testDB(t)
	ativo, idAtivo, _ := novoTenantDeTeste(t, pool, "active")
	suspenso, _, _ := novoTenantDeTeste(t, pool, "suspended")

	tenants, err := NewRegistry(pool).Tenants(context.Background())
	if err != nil {
		t.Fatalf("Tenants devolveu erro: %v", err)
	}

	porSlug := map[string]string{}
	temDefault := false
	for _, tenant := range tenants {
		porSlug[tenant.Slug] = tenant.ID
		if tenant.Slug == DefaultSlug {
			temDefault = true
		}
	}

	if !temDefault {
		t.Errorf("registry sem a linha `default` e o default não foi injetado: %v — o claim do JWT da loja default não casaria nada", porSlug)
	}
	if got := porSlug[ativo]; got != idAtivo {
		t.Errorf("tenant ativo com id %q, quer %q (slugs: %v)", got, idAtivo, porSlug)
	}
	if _, achou := porSlug[suspenso]; achou {
		t.Errorf("tenant SUSPENSO apareceu na lista de tenants a varrer: %v", porSlug)
	}
}

// Resolve é o caminho público (`/realtime/public`, sem JWT): o Host diz a loja.
// Sem isto, a vitrine de uma loja com domínio próprio entraria no escopo do
// default e ficaria muda.
func TestRegistryResolveHost(t *testing.T) {
	pool := testDB(t)
	slug, id, dominio := novoTenantDeTeste(t, pool, "active")

	fonte := NewRegistry(pool)
	casos := []struct {
		host     string
		wantSlug string
		wantID   string
	}{
		{slug + ".pdv.app", slug, id},                        // subdomínio de slug conhecido
		{dominio, slug, id},                                  // domínio próprio (custom_domain)
		{"www." + slug + ".pdv.app", DefaultSlug, DefaultID}, // rótulo reservado ⇒ default
		{"desconhecido.pdv.app", DefaultSlug, DefaultID},     // slug que não existe ⇒ default
		{"localhost:8080", DefaultSlug, DefaultID},           // 1 rótulo ⇒ default
	}

	for _, c := range casos {
		t.Run(c.host, func(t *testing.T) {
			got, err := fonte.Resolve(context.Background(), c.host)
			if err != nil {
				t.Fatalf("Resolve devolveu erro: %v", err)
			}
			if got.Slug != c.wantSlug {
				t.Errorf("Resolve(%q) = slug %q, quer %q", c.host, got.Slug, c.wantSlug)
			}
			if got.ID != c.wantID {
				t.Errorf("Resolve(%q) = id %q, quer %q", c.host, got.ID, c.wantID)
			}
		})
	}
}

// O cache existe porque o dispatcher pergunta a cada 200ms (ver registryTTL).
// Se ele não servisse nada, o registry viraria o alvo de 5 queries por segundo
// por instância. Este teste planta uma linha DEPOIS da primeira leitura e mostra
// que ela só aparece depois do TTL — é a prova de que há cache, e de que ele
// expira.
func TestRegistryCacheExpira(t *testing.T) {
	pool := testDB(t)

	// ttl curto: 60s de produção não cabem num teste, e o comportamento que
	// interessa (lê uma vez, re-lê depois) não depende do valor.
	fonte := &Registry{db: pool, ttl: 150 * time.Millisecond}

	if _, err := fonte.Tenants(context.Background()); err != nil {
		t.Fatalf("primeira leitura falhou: %v", err)
	}

	slug, _, _ := novoTenantDeTeste(t, pool, "active")

	tenants, err := fonte.Tenants(context.Background())
	if err != nil {
		t.Fatalf("segunda leitura falhou: %v", err)
	}
	if contem(tenants, slug) {
		t.Errorf("a linha plantada DEPOIS da primeira leitura apareceu dentro do TTL: não há cache (%v)", tenants)
	}

	time.Sleep(200 * time.Millisecond)
	tenants, err = fonte.Tenants(context.Background())
	if err != nil {
		t.Fatalf("terceira leitura falhou: %v", err)
	}
	if !contem(tenants, slug) {
		t.Errorf("depois do TTL a linha nova não apareceu: o cache não expira (%v)", tenants)
	}
}

func contem(tenants []Tenant, slug string) bool {
	for _, tenant := range tenants {
		if tenant.Slug == slug {
			return true
		}
	}
	return false
}
