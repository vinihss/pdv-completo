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
//
// A chave é (schema, tenant): o `app.tenant_id` vai no startup packet do pool
// (é o que faz o trigger de `tenant_id` preencher a coluna), e um pool criado
// SEM o id (o caminho sem escopo ALS) não pode ser reaproveitado por um
// tenant que tem id — nem o contrário. Schema e tenant são 1:1 no modelo
// atual, então a chave dupla raramente cria dois pools para o mesmo schema —
// mas ela elimina a classe de bug em que o pool "errado" (sem o GUC) serve o
// tenant.
const pools = new Map<string, TenantPoolEntry>();

function poolKey(schemaName: string, tenantId?: string): string {
  return `${schemaName}|${tenantId ?? ""}`;
}

function touch(key: string): void {
  const entry = pools.get(key);
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

/**
 * O `app.tenant_id` no startup packet.
 *
 * O GUC vai no pacote de inicialização da conexão (e não só na transação) por
 * um motivo prático: o TRIGGER que preenche `tenant_id` (migration
 * `0013_tenant_id.sql`) precisa do contexto em TODA inserção — e o pool tem
 * mais de uma conexão. Setar por transação (o Unit-of-Worker faz) cobre o
 * caminho do app, mas o seed e os scripts escreveriam sem contexto e a coluna
 * ficaria nula.
 *
 * Como o pool é POR SCHEMA e o schema é POR TENANT (1:1), o GUC da conexão é
 * sempre o do tenant daquele pool: uma conexão devolvida "suja" só pode estar
 * suja para o PRÓPRIO tenant — a mesma propriedade que sustenta o
 * `search_path` (docs/15 §4.2).
 *
 * O id só entra no pacote se for um UUID válido: um valor malformado no
 * startup packet derrubaria a conexão.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tenantGucOption(tenantId: string | undefined): string {
  if (!tenantId) return "";
  if (!UUID_PATTERN.test(tenantId)) {
    console.warn(
      `[tenant-db] tenant_id ignorado no startup packet (não é um uuid): ${JSON.stringify(tenantId)}`,
    );
    return "";
  }
  return ` -c app.tenant_id=${tenantId}`;
}

function createPool(schemaName: string, tenantId?: string): Pool {
  // Validação em camada: o `search_path` vai para um `-c search_path=...` do
  // startup packet, então o nome precisa ser identificador seguro (mesmo
  // filtro do `resolveTenantSchemaInScope`). O `isValidTenantSchemaName`
  // (`tenant_*`) é regra do REGISTRY e vale na resolução por Host
  // (`resolve-tenant.usecase.ts`), não aqui: o `DEFAULT_TENANT_SCHEMA` é
  // operação e aceita qualquer schema seguro — ex.: `public` ou `umami1`.
  if (!isSafeSchemaName(schemaName)) {
    throw new Error(`[tenant-db] schema_name inválido para pool: ${JSON.stringify(schemaName)}`);
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: tenantPoolMax(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: `-c search_path=${schemaName},public,pg_temp${tenantGucOption(tenantId)}`,
  });

  // Sem este listener, o Node mata o PROCESSO (não só a requisição) quando a
  // conexão OCIOSA do pool morre — o `pg` emite 'error' no pool e, sem
  // ninguém ouvindo, o EventEmitter transforma em "Unhandled 'error' event"
  // (`pg-pool/index.js:62` → `pool.emit('error', err, client)`). Foi o que
  // derrubou o servidor inteiro quando o Postgres caiu com um cliente
  // parado no pool.
  //
  // Log-only de propósito: perder uma conexão não é fatal — a próxima
  // query abre outra. O que NÃO pode é derrubar o servidor por causa disso
  // (mesmo precedente do Redis em `infra/cache/redis-cache-client.ts`).
  pool.on("error", (err) => {
    console.warn(`[tenant-db] erro de conexão no pool de ${schemaName}:`, err?.message ?? String(err));
  });

  return pool;
}

/**
 * Devolve o `Pool` dedicado ao schema — cria um novo quando não existe.
 * O `options` fixa o `search_path` no startup packet de cada conexão.
 */
export function getTenantPool(schemaName: string, tenantId?: string): Pool {
  const key = poolKey(schemaName, tenantId);
  if (!pools.has(key)) {
    evictLRU();
    pools.set(key, { pool: createPool(schemaName, tenantId), lastUsed: Date.now() });
  }
  touch(key);
  return pools.get(key)!.pool;
}

/** Devolve o `db` do Drizzle escopado ao schema do tenant. */
export function tenantDb(schemaName: string, tenantId?: string) {
  return drizzle(getTenantPool(schemaName, tenantId), { schema });
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
  for (const [key, entry] of pools) {
    out.push({
      schema: key.split("|")[0],
      max: tenantPoolMax(),
      used: entry.pool.totalCount,
    });
  }
  return out;
}
