package tenancy

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"sync"
	"time"
)

// registrySQL lê o schema de CONTROLE (`public.tenant`, docs/15 §3.2). É o
// mesmo catálogo que o Node lê em `infra/tenant/registry.ts` e que o
// `ws-gateway/internal/tenancy/registry.go` lê — este serviço não cria tabela
// nenhuma, só lê a que já é o contrato do multi-tenant.
const registrySQL = `SELECT slug, schema_name
	FROM public.tenant
	WHERE status = 'active'
	ORDER BY slug`

// registryTTL é por quanto tempo a lista fica em cache — o MESMO cache de 60s
// do registry do Node. O drain varre a lista a cada 2s; sem cache o registry
// viraria o alvo de meio query por segundo por instância, à toa.
const registryTTL = 60 * time.Second

// registryTimeout é o orçamento de uma ida ao registry dentro de um ciclo.
//
// Curto de propósito: o ciclo do drain roda a cada 2s, e uma consulta pendurada
// seguraria o lote inteiro. Estourou o prazo: usa o último snapshot — um tenant
// provisionado no último minuto espera até a próxima leitura buena, que é um
// atraso, nunca um vazamento.
const registryTimeout = 2 * time.Second

type registryRow struct {
	slug   string
	schema string
}

// Registry lê `public.tenant` com cache e resolve slug → schema, e devolve a
// lista de tenants do ciclo.
//
// Erros são fail-safe, não fail-open: uma consulta que falhou devolve o último
// snapshot bom, e só quem nunca teve snapshot devolve erro — o chamador não
// grava nada nesse caso, em vez de gravar tudo no default (ver Fonte e o
// handler do webhook).
type Registry struct {
	db  *sql.DB
	ttl time.Duration

	mu          sync.Mutex
	rows        []registryRow
	loadedAt    time.Time
	temSnapshot bool
}

// NewRegistry monta o registry a partir de um pool que já responde (db.Connect).
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
		if err := dbRows.Scan(&row.slug, &row.schema); err != nil {
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

// PorSlug devolve o tenant de um slug, fail-closed: slug que não é linha do
// registry devolve erro, nunca um palpite de schema. O slug `default` é
// resolvido pelo `Default()` antes de chegar aqui (o registry pode ainda não
// tê-lo como linha até o cutover, docs/15 §6.2).
func (r *Registry) PorSlug(ctx context.Context, slug string) (Tenant, error) {
	if slug == DefaultSlug {
		return Default(), nil
	}
	rows, err := r.snapshot(ctx)
	if err != nil {
		return Tenant{}, err
	}
	for _, row := range rows {
		if row.slug == slug {
			return Tenant{Slug: row.slug, Schema: row.schema}, nil
		}
	}
	return Tenant{}, fmt.Errorf("tenancy: slug %q não é um tenant ativo no registry (public.tenant) — recusando em vez de chutar schema", slug)
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
			out = append(out, Tenant{Slug: row.slug, Schema: row.schema})
		}
	}
	if !temDefault {
		out = append(out, Default())
	}
	for _, row := range rows {
		if row.slug != DefaultSlug {
			out = append(out, Tenant{Slug: row.slug, Schema: row.schema})
		}
	}
	return out, nil
}
