package tenancy

import (
	"context"
	"database/sql"
	"log"
	"sync"
	"time"
)

// registrySQL lê o schema de CONTROLE (`public.tenant`, docs/15 §3.2). É o
// mesmo catálogo que o Node lê em `infra/tenant/registry.ts` — este serviço não
// cria tabela nenhuma, só lê a que já é o contrato do multi-tenant.
//
// `custom_domain` entra porque a vitrine pública de uma loja com domínio
// próprio (`umamisushiarte.com.br`) não tem subdomínio nenhum que a delate:
// sem esta coluna, o Host resolveria no default e o `order:<uuid>` daquela
// loja ficaria mudo.
const registrySQL = `SELECT id, slug, schema_name, COALESCE(custom_domain, '')
	FROM public.tenant
	WHERE status = 'active'
	ORDER BY slug`

// registryTTL é por quanto tempo a lista fica em cache — o MESMO cache de 60s
// do registry do Node. O dispatcher varre a lista a cada 200ms; sem cache o
// registry viraria o alvo de 5 queries por segundo por instância, à toa.
const registryTTL = 60 * time.Second

// registryTimeout é o orçamento de uma ida ao registry dentro de um ciclo.
//
// Curto de propósito: o ciclo do dispatcher roda a cada 200ms dentro do Run,
// e uma consulta pendurada seguraria o loop inteiro (todos os tenants) junto.
// Estourou o prazo: usa o último snapshot — um tenant provisionado no último
// minuto espera até a próxima leitura buena, que é um atraso, nunca um vazamento.
const registryTimeout = 2 * time.Second

type registryRow struct {
	id           string
	slug         string
	schema       string
	customDomain string
}

// Registry lê `public.tenant` com cache e resolve a fonte de tenants do
// serviço: os tenants ativos MAIS o default (que não é linha do registry até o
// cutover, docs/15 §6.2).
//
// Erros são fail-safe, não fail-open: uma consulta que falhou devolve o último
// snapshot bom, e só quem nunca teve snapshot devolve erro — o chamador não
// publica nada nesse caso, em vez de publicar tudo no default (ver Dispatcher).
type Registry struct {
	db  *sql.DB
	ttl time.Duration

	mu          sync.Mutex
	rows        []registryRow
	loadedAt    time.Time
	temSnapshot bool
}

// NewRegistry monta a fonte a partir de um pool que já responde (db.Connect).
func NewRegistry(db *sql.DB) *Registry {
	return &Registry{db: db, ttl: registryTTL}
}

// snapshot devolve as linhas válidas, refreshando no máximo uma vez por TTL.
func (r *Registry) snapshot(ctx context.Context) ([]registryRow, error) {
	r.mu.Lock()
	fresco := r.temSnapshot && time.Since(r.loadedAt) < r.ttl
	antes := append([]registryRow(nil), r.rows...)
	temSnapshot := r.temSnapshot
	r.mu.Unlock()
	if fresco {
		return antes, nil
	}

	qctx, cancel := context.WithTimeout(ctx, registryTimeout)
	defer cancel()

	rows, err := r.ler(qctx)
	if err != nil {
		if temSnapshot {
			log.Printf("[tenancy] registry indisponível (%v) — usando o último snapshot", err)
			return antes, nil
		}
		return nil, err
	}

	r.mu.Lock()
	r.rows = rows
	r.loadedAt = time.Now()
	r.temSnapshot = true
	r.mu.Unlock()
	return append([]registryRow(nil), rows...), nil
}

// ler executa a consulta e filtra linha inválida com aviso: uma linha corrompida
// no registry (constraint derrubado) não pode virar `search_path` — é a mesma
// segunda barreira do Node, que valida de novo em código.
func (r *Registry) ler(ctx context.Context) ([]registryRow, error) {
	dbRows, err := r.db.QueryContext(ctx, registrySQL)
	if err != nil {
		return nil, err
	}
	defer dbRows.Close()

	var out []registryRow
	for dbRows.Next() {
		var row registryRow
		if err := dbRows.Scan(&row.id, &row.slug, &row.schema, &row.customDomain); err != nil {
			return nil, err
		}
		if !ValidSlug(row.slug) || !ValidSchema(row.schema) {
			log.Printf("[tenancy] registry com linha inválida ignorada: slug=%q schema=%q", row.slug, row.schema)
			continue
		}
		out = append(out, row)
	}
	return out, dbRows.Err()
}

// Tenants devolve os ativos do registry, com o default na frente (a menos que
// o registry tenha uma linha `default` — o cutover, docs/15 §6.2; nesse caso a
// linha do registry é a fonte da verdade e substitui o default injetado).
func (r *Registry) Tenants(ctx context.Context) ([]Tenant, error) {
	rows, err := r.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	var out []Tenant
	temDefault := false
	for _, row := range rows {
		if row.slug == DefaultSlug {
			temDefault = true
			out = append(out, Tenant{ID: row.id, Slug: row.slug, Schema: row.schema})
		}
	}
	if !temDefault {
		out = append(out, Default())
	}
	for _, row := range rows {
		if row.slug != DefaultSlug {
			out = append(out, Tenant{ID: row.id, Slug: row.slug, Schema: row.schema})
		}
	}
	return out, nil
}

// Resolve devolve o tenant do Host: custom_domain do registry, depois a 1ª
// label como slug, e o resto cai no default (ver resolveHost).
func (r *Registry) Resolve(ctx context.Context, host string) (Tenant, error) {
	rows, err := r.snapshot(ctx)
	if err != nil {
		return Tenant{}, err
	}
	porSlug := func(slug string) (Tenant, bool) {
		for _, row := range rows {
			if row.slug == slug {
				return Tenant{ID: row.id, Slug: row.slug, Schema: row.schema}, true
			}
		}
		return Tenant{}, false
	}
	porCustom := func(h string) (Tenant, bool) {
		for _, row := range rows {
			if row.customDomain != "" && row.customDomain == h {
				return Tenant{ID: row.id, Slug: row.slug, Schema: row.schema}, true
			}
		}
		return Tenant{}, false
	}
	return resolveHost(host, porSlug, porCustom), nil
}
