import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { withIdempotency } from "../src/http/middlewares/idempotency.middleware.js";
import { seedFixture, resetState, closeTestApp } from "./helpers.js";
import { rawSqlite } from "../src/infra/db/client.js";

const ENDPOINT = "TEST/unit";

function installKey(correlationId: string, status: string, requestHash: string, expiresAt: string) {
  rawSqlite
    .prepare(
      `INSERT INTO idempotency_key (correlation_id, endpoint, request_hash, status, expires_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(correlationId, ENDPOINT, requestHash, status, expiresAt);
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
    installKey("c-lock", "processing", hashOf({ x: 1 }), new Date(Date.now() + 60_000).toISOString());
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
    const row = rawSqlite
      .prepare(`SELECT status FROM idempotency_key WHERE correlation_id = 'c-2'`)
      .get() as { status: string };
    expect(row.status).toBe("completed");
  });

  it("chave expirada é reprocessada, mesmo estando completed", async () => {
    await withIdempotency(ENDPOINT, "c-exp", { x: 1 }, async () => ({ status: 200, body: { old: true } }));
    rawSqlite.prepare(`UPDATE idempotency_key SET expires_at = '2000-01-01T00:00:00.000Z' WHERE correlation_id = 'c-exp'`).run();

    let ran = 0;
    const result = await withIdempotency(ENDPOINT, "c-exp", { x: 1 }, async () => {
      ran++;
      return { status: 200, body: { fresh: true } };
    });
    expect(result.body).toEqual({ fresh: true });
    expect(ran).toBe(1);
  });
});