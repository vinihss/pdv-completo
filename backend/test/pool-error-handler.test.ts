// Regressão do crash que MATAVA o servidor inteiro: quando o Postgres cai
// com um cliente OCIOSO no pool, o `pg` emite 'error' no pool e, sem nenhum
// listener registrado, o Node transforma isso em "Unhandled 'error' event"
// (`pg-pool/index.js:62` → `pool.emit('error', err, client)`) e DERRUBA O
// PROCESSO — não só a requisição. O `tsx watch` não reinicia o filho, então a
// API ficava em 502 até alguém reiniciar o container.
//
// O caminho exercitado aqui é o do `pg_terminate_backend` (encerrar a própria
// sessão): ele passa pelo MESMO `pool.emit('error', err, client)` do
// `postgres` fora do ar, sem precisar derrubar o banco nem de privilégio
// especial (qualquer papel pode encerrar a própria sessão).
import { afterAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { config } from "../src/config/env.js";
import { closeAllTenantPools, getTenantPool } from "../src/infra/db/tenant-db.js";

// Schema PRÓPRIO do teste (aceito pelo `SAFE_SCHEMA_NAME_PATTERN`): o pool
// deste arquivo é descartado no fim, sem encostar no pool default.
const SCHEMA = "tenant_pool_error_test";

afterAll(async () => {
  // Fecha tudo — a suíte aborta se sobrar conexão pendurada no banco.
  await closeAllTenantPools();
});

describe("Pool de tenant — 'error' do pg não pode derrubar o processo", () => {
  it("registra listener de 'error' no pool", () => {
    const pool = getTenantPool(SCHEMA);
    // Sem este listener, o EventEmitter lança o erro e o Node mata o server.
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });

  it("emite 'error' no pool sem lançar (log-only, sem rethrow)", () => {
    const pool = getTenantPool(SCHEMA);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Sem listener, o `emit` LANÇA (e no processo real o throw é o do
      // próprio Node: "Unhandled 'error' event").
      expect(() => pool.emit("error", new Error("falha simulada"))).not.toThrow();
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain("[tenant-db]");
    } finally {
      warn.mockRestore();
    }
  });

  it("sobrevive à queda da conexão ociosa do pool (o crash de verdade)", async (ctx) => {
    const pool = getTenantPool(SCHEMA);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // Conexão real do pool: depois da query ela fica OCIOSA dentro do pool
      // — que é o estado exato em que o crash acontecia.
      const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0].pid;

      // Outra sessão (fora do pool) encerra aquele backend.
      const admin = new Client({ connectionString: config.databaseUrl });
      try {
        await admin.connect();
        await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      } catch {
        // Ambiente que não deixa encerrar a própria sessão: o bônus não roda,
        // mas a regressão real (os dois testes acima) segue de pé.
        ctx.skip();
        return;
      } finally {
        await admin.end().catch(() => {});
      }

      // O pool emite 'error'. SEM o listener isso é "Unhandled 'error' event":
      // o processo morre — e o runner de teste junto com ele.
      await vi.waitFor(
        () => {
          expect(warn.mock.calls.some((c) => String(c[0]).includes("[tenant-db]"))).toBe(true);
        },
        { timeout: 5000, interval: 50 },
      );
    } finally {
      warn.mockRestore();
    }
  });
});
