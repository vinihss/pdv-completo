import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../../config/env.js";
import * as schema from "./schema.js";
import { DEFAULT_TENANT_ID } from "../../domain/tenant.js";
import { currentTenantId, resolveTenantSchemaInScope } from "./tenant-context.js";
import { getTenantPool, tenantDb, closeAllTenantPools } from "./tenant-db.js";

// Postgres é o ÚNICO banco suportado (o SQLite foi removido). O Drizzle
// com node-postgres é assíncrono de verdade: TODO acesso é `await`, e
// `db.transaction(cb)` exige `cb` async — ver a nota em
// application/order/order.usecases.ts.
//
// `db` é um Proxy: cada query resolve o schema do ALS (via
// `resolveTenantSchemaInScope`) e encaminha para o pool dedicado daquele
// tenant (`tenantDb`). O isolamento é ESTRUTURAL — cada pool fala só com
// o schema dele (`options: '-c search_path=...'` no startup packet).
//
// Os 43 arquivos que importam `db` não mudam uma linha: o Proxy é
// transparente.
type DbLike = ReturnType<typeof tenantDb>;

/**
 * O tenant da requisição.
 *
 * Sem escopo ALS (scripts, seed, jobs) o tenant é o DEFAULT — a mesma regra
 * do schema: `resolveTenantSchemaInScope()` cai no schema default quando não
 * há escopo, e o tenant cai no default junto. Sem essa simetria, o
 * `app.tenant_id` do pool seria vazio e o trigger de `tenant_id` deixaria a
 * coluna nula.
 */
function currentDb(): DbLike {
  // O `tenantId` vai junto: o pool de um tenant carrega o `app.tenant_id` no
  // startup packet (é o que faz o trigger de `tenant_id` preencher a coluna em
  // qualquer inserção, inclusive fora do Unit-of-Worker).
  return tenantDb(currentTenantId());
}

export const db = new Proxy({} as DbLike, {
  get(_target, prop, receiver) {
    const target = currentDb();
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// `pool` é getter: depois de `closeDatabase()`, o mapa de pools é limpo e
// qualquer acesso posterior precisa de um pool NOVO (e não o velho já fechado).
// Sem o getter, o `pool` exportado ficaria apontando para um pool encerrado
// e todo acesso subsequente falharia com "Called end on pool more than once".
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const target = getTenantPool(currentTenantId());
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  // `closeAllTenantPools` já fecha TODOS os pools do mapa — incluindo o que
  // `pool` aponta — então chamar `pool.end()` de novo seria "Called end on
  // pool more than once".
  await closeAllTenantPools();
}
