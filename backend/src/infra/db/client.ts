import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../../config/env.js";
import * as schema from "./schema.js";

// Postgres é o ÚNICO banco suportado (o SQLite foi removido). O Drizzle
// com node-postgres é assíncrono de verdade: TODO acesso é `await`, e
// `db.transaction(cb)` exige `cb` async — ver a nota em
// application/order/order.usecases.ts.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  // Uma conexão por request não basta: transação + queries de fora dela
  // (ou dois requests concorrentes na mesma transação) precisam de folga.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  // Sem listener, um cliente morto no pool derruba o processo inteiro.
  console.error("[db] erro em cliente ocioso do pool:", err.message);
});

export const db = drizzle(pool, { schema });

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
  await pool.end();
}
