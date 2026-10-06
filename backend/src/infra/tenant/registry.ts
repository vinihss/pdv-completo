// Acesso ao REGISTRY de tenants (`public.tenant`) — a tabela de controle do
// multi-tenant (`docs/15-multi-tenant-schema.md` §3.2).
//
// SQL CRU, e não Drizzle, de propósito: `infra/db/schema.ts` descreve as tabelas
// que o app usa **dentro do schema do tenant** (é o DDL que o baseline
// `0001_init.sql` replica em cada loja, §6.2). A única tabela que é sempre
// `public` é `tenant` — registrá-la ali faria o `drizzle-kit` (e qualquer
// `generate` futuro) produzirem `CREATE TABLE tenant` para dentro de cada schema
// de loja, que é exatamente o que o §3.2 proíbe. Por isso as queries aqui são
// qualificadas com `public.` e escritas à mão.
//
// Cache: `MemoryCache` (o mesmo singleton de `infra/cache`), com TTL de 60s —
// o número que o §6 da Fase 5 já usa para as consultas ao registry (CORS por
// host). A chave é o próprio host/slug, que já é único entre lojas; a partição
// por schema que o §4.4 pede para o cache de dados (`${schema}:${key}`) não é
// necessária aqui porque não há chave global para vazar entre tenants.

import { pool } from "../db/client.js";
import { getCache } from "../cache/index.js";

export type TenantStatus = "active" | "suspended";

export type TenantRecord = {
  slug: string;
  /** `schema_name` do registry. NUNCA sai para o cliente — é topologia interna. */
  schemaName: string;
  displayName: string;
  status: TenantStatus;
  customDomain: string | null;
};

const CACHE_PREFIX = "tenant-registry:";
/** TTL padrão em segundos. O §6 da Fase 5 fixa 60s para consulta ao registry. */
const DEFAULT_TTL_SECONDS = 60;

// Lido de `process.env` a CADA chamada (e não no load do módulo) por dois
// motivos: é o que torna o TTL ajustável em teste sem reimportar o módulo, e é
// o mesmo formato que a leitura do ambiente vai ter quando o valor vier do
// request (Fase 2). O `config` de `config/env.ts` é snapshot no load e não serve
// para isto — a seam em `infra/storage/tenant.ts` usa a mesma estratégia.
function ttlSeconds(): number {
  const raw = process.env.TENANT_REGISTRY_CACHE_TTL_SECONDS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_SECONDS;
}

type Cached<T> = { tenant: T | null };

function readCache<T>(key: string): { hit: boolean; tenant: T | null } {
  // O envelope existe para que um resultado NEGATIVO possa ser cacheado: o
  // `MemoryCache.get` devolve `null` tanto para "não cacheado" quanto para
  // "cacheado com valor null". Sem o envelope, todo subdomínio inexistente
  // viraria uma query ao banco por request — que é o que um scanner de
  // subdomínio quer.
  const entry = getCache().get<Cached<T>>(`${CACHE_PREFIX}${key}`);
  if (!entry) return { hit: false, tenant: null };
  return { hit: true, tenant: entry.tenant };
}

function writeCache<T>(key: string, tenant: T | null): void {
  getCache().set<Cached<T>>(`${CACHE_PREFIX}${key}`, { tenant }, { ttl: ttlSeconds() });
}

const SELECT_COLUMNS = "slug, schema_name, display_name, status, custom_domain";

function toRecord(row: Record<string, unknown>): TenantRecord {
  return {
    slug: String(row.slug),
    schemaName: String(row.schema_name),
    displayName: String(row.display_name),
    status: row.status === "suspended" ? "suspended" : "active",
    customDomain: row.custom_domain === null || row.custom_domain === undefined ? null : String(row.custom_domain),
  };
}

/** Tenant pelo `slug` (a 1ª label do subdomínio). `null` = não existe. */
export async function findTenantBySlug(slug: string): Promise<TenantRecord | null> {
  const cached = readCache<TenantRecord>(`slug:${slug}`);
  if (cached.hit) return cached.tenant;

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM public.tenant WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  const tenant = rows.length > 0 ? toRecord(rows[0]) : null;
  writeCache(`slug:${slug}`, tenant);
  return tenant;
}

/**
 * Tenant pelo domínio próprio (`umamisushiarte.com.br`). O `lower()` cobre o
 * case-insensitive do hostname; o índice único parcial é sobre `lower()`, então
 * a query bate nele.
 */
export async function findTenantByCustomDomain(host: string): Promise<TenantRecord | null> {
  const cached = readCache<TenantRecord>(`host:${host}`);
  if (cached.hit) return cached.tenant;

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM public.tenant WHERE lower(custom_domain) = lower($1) LIMIT 1`,
    [host],
  );
  const tenant = rows.length > 0 ? toRecord(rows[0]) : null;
  writeCache(`host:${host}`, tenant);
  return tenant;
}

/**
 * Invalida o cache do registry. Não há escrita no registry na Fase 1 (o
 * provisionamento é um script manual, §8 do doc 15, e ele não existe ainda), então
 * quem chama isto hoje é o teste e o próximo a provisionar uma loja. É o que a
 * TTL de 60s tornaria lento demais: provisionar uma loja e esperar um minuto
 * para ela aparecer no app é um sintoma difícil de diagnosticar.
 */
export function invalidateTenantRegistryCache(): void {
  getCache().invalidatePattern(`${CACHE_PREFIX}*`);
}
