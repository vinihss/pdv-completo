import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { withIdempotency } from "../src/http/middlewares/idempotency.middleware.js";
import { seedFixture, resetState, closeTestApp, raw } from "./helpers.js";
import { pool } from "../src/infra/db/client.js";

const ENDPOINT = "TEST/unit";

async function installKey(correlationId: string, status: string, requestHash: string, expiresAt: string) {
  await raw.all(`INSERT INTO idempotency_key (correlation_id, endpoint, request_hash, status, expires_at) VALUES ($1, $2, $3, $4, $5)`, [correlationId, ENDPOINT, requestHash, status, expiresAt]);
  return correlationId;
}

function hashOf(body: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

describe("idempotência (1.4)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("replay completed devolve a resposta cacheada, sem reprocessar", async () => {
    let calls = 0;
    const handler = async () => {
      calls++;
      return { status: 201, body: { n: calls } };
    };
    const a = await withIdempotency(ENDPOINT, "c-1", { x: 1 }, handler);
    const b = await withIdempotency(ENDPOINT, "c-1", { x: 1 }, handler);
    expect(a.body).toEqual(b.body);
    expect(calls).toBe(1);
  });

  it("correlationId reutilizado com corpo diferente → 400", async () => {
    await withIdempotency(ENDPOINT, "c-1", { x: 1 }, async () => ({ status: 200, body: {} }));
    await expect(
      withIdempotency(ENDPOINT, "c-1", { x: 2 }, async () => ({ status: 200, body: {} }))
    ).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("estado processing (request em voo) → 409", async () => {
    await installKey("c-lock", "processing", hashOf({ x: 1 }), new Date(Date.now() + 60_000).toISOString());
    await expect(
      withIdempotency(ENDPOINT, "c-lock", { x: 1 }, async () => ({ status: 200, body: {} }))
    ).rejects.toMatchObject({ status: 409 });
  });

  it("falha server-side vira retry: failed é reprocessado no replay (sem 500)", async () => {
    let calls = 0;
    const handler = async () => {
      calls++;
      if (calls === 1) throw new Error("boom transiente");
      return { status: 200, body: { ok: true } };
    };

    await expect(withIdempotency(ENDPOINT, "c-2", { x: 1 }, handler)).rejects.toThrow("boom transiente");
    // Antes do fix isto estourava 500 (colisão de PK ao tentar inserir de novo);
    // agora reusa a linha "failed" e reprocessa.
    const retry = await withIdempotency(ENDPOINT, "c-2", { x: 1 }, handler);
    expect(retry.body).toEqual({ ok: true });
    expect(calls).toBe(2);

    // e o estado final é completed
    const row = await raw.get(`SELECT status FROM idempotency_key WHERE correlation_id = 'c-2'`) as { status: string };
    expect(row.status).toBe("completed");
  });

  it("chave expirada é reprocessada, mesmo estando completed", async () => {
    await withIdempotency(ENDPOINT, "c-exp", { x: 1 }, async () => ({ status: 200, body: { old: true } }));
    await raw.exec(`UPDATE idempotency_key SET expires_at = '2000-01-01T00:00:00.000Z' WHERE correlation_id = 'c-exp'`);

    let ran = 0;
    const result = await withIdempotency(ENDPOINT, "c-exp", { x: 1 }, async () => {
      ran++;
      return { status: 200, body: { fresh: true } };
    });
    expect(result.body).toEqual({ fresh: true });
    expect(ran).toBe(1);
  });

  it("race do check-then-insert: a perdedora da colisão de PK não vira 500", async () => {
    // Reprodução determinística da corrida: outra transação insere a chave e
    // NÃO comita. O pre-check da perdedora (READ COMMITTED) não enxerga a
    // linha não commitada, então ela passa pela checagem e trava no INSERT
    // até o commit alheio — que é quando o 23505 aparece, embrulhado em
    // DrizzleQueryError. Sem desembrulhar o `cause`, isso vira 500.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `INSERT INTO idempotency_key (correlation_id, endpoint, request_hash, response_body, response_status, status, expires_at)
         VALUES ($1, $2, $3, $4, 201, 'completed', '2999-01-01T00:00:00.000Z')`,
        ["c-race", ENDPOINT, hashOf({ x: 1 }), JSON.stringify({ cached: true })]
      );

      let ran = false;
      const pending = withIdempotency(ENDPOINT, "c-race", { x: 1 }, async () => {
        ran = true;
        return { status: 201, body: { cached: false } };
      });
      await new Promise((r) => setTimeout(r, 150));
      await holder.query("COMMIT");

      const res = await pending;
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ cached: true });
      expect(ran).toBe(false);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  });

  it("requests idênticos simultâneos: um só executa o handler, nenhuma resposta é 500", async () => {
    let calls = 0;
    const handler = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { status: 201, body: { n: calls } };
    };

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => withIdempotency(ENDPOINT, "c-par", { x: 1 }, handler))
    );

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const f of failed) {
      // 409 "em processamento" é a resposta correta da perdedora; o que não
      // pode acontecer é o 23505 escapando como erro interno.
      expect(f.reason).toMatchObject({ code: "validation_failed", status: 409 });
      expect((f.reason as { code?: string }).code).not.toBe("23505");
    }
    expect(calls).toBeLessThanOrEqual(1);

    const rows = await raw.all(`SELECT status FROM idempotency_key WHERE correlation_id = 'c-par'`);
    expect(rows).toHaveLength(1);
  });
});