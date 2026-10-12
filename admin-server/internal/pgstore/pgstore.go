// Package pgstore é a implementação pgx das interfaces que o httpapi consome
// (TenantStore e SettingsStore). O acoplamento é estrutural: este pacote não
// importa httpapi, e httpapi não importa este — main liga os dois.
package pgstore

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"pdv-admin-server/internal/settings"
	"pdv-admin-server/internal/tenants"
)

// tenantColumns é a projeção do registry usada em SELECT e RETURNING.
const tenantColumns = "slug, schema_name, display_name, status, custom_domain, created_at"

// selectColumns é a lista de colunas de store_settings já citada, na ordem de
// settings.Columns (que casa com ScanDest).
var selectColumns = func() string {
	parts := make([]string, len(settings.Columns))
	for i, c := range settings.Columns {
		parts[i] = pgx.Identifier{c}.Sanitize()
	}
	return strings.Join(parts, ", ")
}()

// Store é o pool do Postgres.
type Store struct {
	pool *pgxpool.Pool
}

// New abre o pool e confere que o banco responde.
func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

// Close devolve as conexões.
func (s *Store) Close() { s.pool.Close() }

func scanTenant(row pgx.Row) (tenants.Tenant, error) {
	var t tenants.Tenant
	err := row.Scan(&t.Slug, &t.SchemaName, &t.DisplayName, &t.Status, &t.CustomDomain, &t.CreatedAt)
	return t, err
}

// ListTenants devolve todos os tenants, mais recentes primeiro.
func (s *Store) ListTenants(ctx context.Context) ([]tenants.Tenant, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT "+tenantColumns+" FROM public.tenant ORDER BY created_at DESC, slug ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []tenants.Tenant
	for rows.Next() {
		t, err := scanTenant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTenant busca um tenant pelo slug. found=false quando não existe.
func (s *Store) GetTenant(ctx context.Context, slug string) (tenants.Tenant, bool, error) {
	t, err := scanTenant(s.pool.QueryRow(ctx,
		"SELECT "+tenantColumns+" FROM public.tenant WHERE slug = $1", slug))
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, false, nil
	}
	if err != nil {
		return tenants.Tenant{}, false, err
	}
	return t, true, nil
}

// UpdateTenantName renomeia e devolve a linha atualizada.
func (s *Store) UpdateTenantName(ctx context.Context, slug, displayName string) (tenants.Tenant, bool, error) {
	t, err := scanTenant(s.pool.QueryRow(ctx,
		"UPDATE public.tenant SET display_name = $2 WHERE slug = $1 RETURNING "+tenantColumns,
		slug, displayName))
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, false, nil
	}
	if err != nil {
		return tenants.Tenant{}, false, err
	}
	return t, true, nil
}

// UpdateTenantStatus troca active/suspended e devolve a linha atualizada.
func (s *Store) UpdateTenantStatus(ctx context.Context, slug, status string) (tenants.Tenant, bool, error) {
	t, err := scanTenant(s.pool.QueryRow(ctx,
		"UPDATE public.tenant SET status = $2 WHERE slug = $1 RETURNING "+tenantColumns,
		slug, status))
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, false, nil
	}
	if err != nil {
		return tenants.Tenant{}, false, err
	}
	return t, true, nil
}

// schemaFor resolve o schema_name SEMPRE a partir do slug no registry. O nome
// do schema nunca vem do request — é o único jeito de o Sanitize ser confiável.
func (s *Store) schemaFor(ctx context.Context, slug string) (string, bool, error) {
	var schema string
	err := s.pool.QueryRow(ctx,
		"SELECT schema_name FROM public.tenant WHERE slug = $1", slug).Scan(&schema)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return schema, true, nil
}

// GetSettings lê a linha singleton de store_settings do tenant. found=false
// apenas quando o tenant não existe.
func (s *Store) GetSettings(ctx context.Context, slug string) (*settings.StoreSettings, bool, error) {
	schema, found, err := s.schemaFor(ctx, slug)
	if err != nil || !found {
		return nil, found, err
	}
	return s.settingsInSchema(ctx, schema)
}

func (s *Store) settingsInSchema(ctx context.Context, schema string) (*settings.StoreSettings, bool, error) {
	table := pgx.Identifier{schema, "store_settings"}.Sanitize()
	q := fmt.Sprintf("SELECT %s FROM %s WHERE id = 'singleton'", selectColumns, table)

	var st settings.StoreSettings
	err := s.pool.QueryRow(ctx, q).Scan(st.ScanDest()...)
	if errors.Is(err, pgx.ErrNoRows) {
		// Tenant existe, mas sem a linha singleton: é inconsistência, não 404.
		return nil, false, fmt.Errorf("tenant %q sem store_settings", schema)
	}
	if err != nil {
		return nil, false, err
	}
	return &st, true, nil
}

// UpdateSettings aplica o patch parcial e devolve a linha atualizada. O
// identificador das colunas vem da whitelist de settings; o do schema, do
// registry — nada do request entra como identificador.
func (s *Store) UpdateSettings(ctx context.Context, slug string, patch *settings.Patch) (*settings.StoreSettings, bool, error) {
	schema, found, err := s.schemaFor(ctx, slug)
	if err != nil || !found {
		return nil, found, err
	}

	if len(patch.Columns) == 0 {
		return s.settingsInSchema(ctx, schema)
	}

	table := pgx.Identifier{schema, "store_settings"}.Sanitize()
	q := fmt.Sprintf("UPDATE %s SET %s WHERE id = 'singleton' RETURNING %s",
		table, strings.Join(patch.Assignments(1), ", "), selectColumns)

	var st settings.StoreSettings
	err = s.pool.QueryRow(ctx, q, patch.Args...).Scan(st.ScanDest()...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, fmt.Errorf("tenant %q sem store_settings", schema)
	}
	if err != nil {
		return nil, false, err
	}
	return &st, true, nil
}
