import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../../config/env.js";
import * as schema from "./schema.js";
import { resolveTenantSchemaInScope } from "./tenant-context.js";
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

function currentDb(): DbLike {
  return tenantDb(resolveTenantSchemaInScope());
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
    const target = getTenantPool(resolveTenantSchemaInScope());
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
