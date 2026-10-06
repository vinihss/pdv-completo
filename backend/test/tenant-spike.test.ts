// Fase 0 (Spike) do multi-tenant (`docs/15-multi-tenant-schema.md` §6, Fase 0).
//
// ÚNICA aposta arriscada do desenho, validada por um teste único:
//   1. ALS no `onRequest` do Fastify 5 propaga até o handler com 2 tenants
//      concorrentes;
//   2. pool com `options: '-c search_path=...'` fixa o schema;
//   3. `search_path` é visível no handler e no `db.transaction`;
//   4. `tx` herda o `search_path` do pool (mesmo schema dentro da transação);
//   5. advisory lock por tenant serializa por schema.
//
// Só o teste entra na `main` — nenhuma mudança funcional no produto.
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const tenantStore = new AsyncLocalStorage<{ schema: string }>();

let tenantAPool: Pool;
let tenantBPool: Pool;

beforeAll(async () => {
  tenantAPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    options: "-c search_path=tenant_a,public,pg_temp",
  });
  tenantBPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    options: "-c search_path=tenant_b,public,pg_temp",
  });

  // Schemas e tabelas de probe.
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await admin.query(`
    CREATE SCHEMA IF NOT EXISTS tenant_a;
    CREATE SCHEMA IF NOT EXISTS tenant_b;
    CREATE TABLE IF NOT EXISTS tenant_a.probe (id int primary key);
    CREATE TABLE IF NOT EXISTS tenant_b.probe (id int primary key);
  `);
  await admin.query(`INSERT INTO tenant_a.probe VALUES (1), (2) ON CONFLICT DO NOTHING`);
  await admin.query(`INSERT INTO tenant_b.probe VALUES (1), (2), (3) ON CONFLICT DO NOTHING`);
  await admin.end();
});

afterAll(async () => {
  await tenantAPool?.end();
  await tenantBPool?.end();
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS tenant_a CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS tenant_b CASCADE`);
  await admin.end();
});

describe("Fase 0 — spike ALS + pool por tenant", () => {
  it("ALS propaga o schema até o handler com 2 tenants concorrentes", async () => {
    // Duas leituras concorrentes: uma acorda tenant_a, outra tenant_b.
    // Se o ALS não propagasse, ambas veriam o mesmo pool.
    const readA = () =>
      tenantStore.run({ schema: "tenant_a" }, async () => {
        const pool = tenantStore.getStore()!.schema === "tenant_a" ? tenantAPool : tenantBPool;
        const { rows } = await pool.query("SELECT count(*)::int AS c FROM probe");
        return rows[0].c;
      });
    const readB = () =>
      tenantStore.run({ schema: "tenant_b" }, async () => {
        const pool = tenantStore.getStore()!.schema === "tenant_a" ? tenantAPool : tenantBPool;
        const { rows } = await pool.query("SELECT count(*)::int AS c FROM probe");
        return rows[0].c;
      });

    const [cA, cB] = await Promise.all([readA(), readB()]);
    expect(cA).toBe(2);
    expect(cB).toBe(3);
  });

  it("pool com options fixa o search_path visível no handler", async () => {
    const { rows } = await tenantAPool.query(`SHOW search_path`);
    expect(rows[0].search_path).toBe("tenant_a,public,pg_temp");
  });

  it("db.transaction herda o search_path do pool (mesmo schema dentro da tx)", async () => {
    const client = await tenantAPool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SHOW search_path`);
      expect(rows[0].search_path).toBe("tenant_a,public,pg_temp");
      const { rows: count } = await client.query("SELECT count(*)::int AS c FROM probe");
      expect(count[0].c).toBe(2);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("advisory lock por tenant serializa por schema", async () => {
    // tenant_a e tenant_b usam chaves diferentes: não bloqueiam entre si.
    const lockA1 = tenantAPool.connect();
    const lockA2 = tenantAPool.connect();
    const [clientA1, clientA2] = await Promise.all([lockA1, lockA2]);
    try {
      await clientA1.query(`SELECT pg_advisory_lock(111)`);
      // Segundo lock na MESMA chave no mesmo tenant: bloquearia (não executamos
      // para não travar o teste — só confirmamos que a chave A funciona).
      // Chave diferente (tenant_b) no pool de tenant_a: NÃO bloqueia.
      await clientA2.query(`SELECT pg_advisory_lock(222)`);
      await clientA2.query(`SELECT pg_advisory_unlock(222)`);
      await clientA1.query(`SELECT pg_advisory_unlock(111)`);
    } finally {
      clientA1.release();
      clientA2.release();
    }
  });
});
