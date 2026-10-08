// Pool dedicado por tenant (Map + LRU) — Fase 2 do
// `docs/15-multi-tenant-schema.md` §4.2.
//
// O isolamento é ESTRUTURAL: cada schema tem um `pg.Pool` cujo
// `options: '-c search_path=...'` está fixado no startup packet.
// Uma conexão devolvida "suja" só pode estar suja para o PRÓPRIO tenant,
// porque o pool inteiro fala com aquele schema — impossível vazar.
//
// LRU: quando `TENANT_POOL_MAX_TOTAL` é atingido, o pool MENOS USADO faz
// `pool.end()`. O próximo request para aquele tenant cria um pool novo
// (com o mesmo `options`). Nenhum dado é perdido: `search_path` é
// reafirmado no startup de cada conexão nova.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../../config/env.js";
import { isSafeSchemaName } from "../../domain/tenant.js";
import * as schema from "./schema.js";

// Cada tenant tem o seu `Pool` com `max: TENANT_POOL_MAX`.
// Enquanto um tenant está ativo, `TENANT_POOL_MAX` conexões no máximo.
// `TENANT_POOL_MAX_TOTAL` limita o NÚMERO de tenants com pool aberto.
const DEFAULT_TENANT_POOL_MAX = 4;
const DEFAULT_TENANT_POOL_MAX_TOTAL = 16;

function tenantPoolMax(): number {
  const raw = process.env.TENANT_POOL_MAX;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_TENANT_POOL_MAX;
}

function tenantPoolMaxTotal(): number {
  const raw = process.env.TENANT_POOL_MAX_TOTAL;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_TENANT_POOL_MAX_TOTAL;
}

type TenantPoolEntry = {
  pool: Pool;
  lastUsed: number;
};

// LRU simples: array com o mais recentemente usado POR ÚLTIMO.
const pools = new Map<string, TenantPoolEntry>();

function touch(schemaName: string): void {
  const entry = pools.get(schemaName);
  if (entry) entry.lastUsed = Date.now();
}

function evictLRU(): void {
  const total = tenantPoolMaxTotal();
  while (pools.size >= total) {
    let oldestKey = "";
    let oldest = Infinity;
    for (const [key, entry] of pools) {
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const entry = pools.get(oldestKey)!;
    pools.delete(oldestKey);
    entry.pool.end().catch((err) =>
      console.error(`[tenant-db] erro ao fechar pool de ${oldestKey}:`, err.message),
    );
  }
}

function createPool(schemaName: string): Pool {
  // Validação em camada: o `search_path` vai para um `-c search_path=...` do
  // startup packet, então o nome precisa ser identificador seguro (mesmo
  // filtro do `resolveTenantSchemaInScope`). O `isValidTenantSchemaName`
  // (`tenant_*`) é regra do REGISTRY e vale na resolução por Host
  // (`resolve-tenant.usecase.ts`), não aqui: o `DEFAULT_TENANT_SCHEMA` é
  // operação e aceita qualquer schema seguro — ex.: `public` ou `umami1`.
  if (!isSafeSchemaName(schemaName)) {
    throw new Error(`[tenant-db] schema_name inválido para pool: ${JSON.stringify(schemaName)}`);
  }

  return new Pool({
    connectionString: config.databaseUrl,
    max: tenantPoolMax(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: `-c search_path=${schemaName},public,pg_temp`,
  });
}

/**
 * Devolve o `Pool` dedicado ao schema — cria um novo quando não existe.
 * O `options` fixa o `search_path` no startup packet de cada conexão.
 */
export function getTenantPool(schemaName: string): Pool {
  if (!pools.has(schemaName)) {
    evictLRU();
    pools.set(schemaName, { pool: createPool(schemaName), lastUsed: Date.now() });
  }
  touch(schemaName);
  return pools.get(schemaName)!.pool;
}

/** Devolve o `db` do Drizzle escopado ao schema do tenant. */
export function tenantDb(schemaName: string) {
  return drizzle(getTenantPool(schemaName), { schema });
}

/** Fecha TODOS os pools (usado no shutdown do processo). */
export async function closeAllTenantPools(): Promise<void> {
  const closings = [...pools.values()].map((p) => p.pool.end());
  pools.clear();
  await Promise.allSettled(closings);
}

/** Mapa atual (só para testes/diagnóstico — não muta). */
export function getTenantPoolSnapshot(): Array<{ schema: string; max: number; used: number }> {
  const out: Array<{ schema: string; max: number; used: number }> = [];
  for (const [schemaName, entry] of pools) {
    out.push({ schema: schemaName, max: tenantPoolMax(), used: entry.pool.totalCount });
  }
  return out;
}
