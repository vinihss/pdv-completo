import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { idempotencyKeys } from "../../infra/db/schema.js";
import { isUniqueViolation } from "../../infra/db/errors.js";
import { AppError } from "../../domain/errors.js";

function hashBody(body: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

const TTL_MS = 15 * 60_000;

/**
 * Implementa o fluxo de idempotência da §10:
 * - Não existe -> grava "processing", executa o handler, marca "completed".
 * - Existe "completed" e válido -> devolve a resposta cacheada, sem reprocessar.
 * - Existe "processing" e válido -> 409 (requisição concorrente idêntica em voo).
 * - Existe "failed" ou com `expires_at` expirado -> REPROCESSA (1.4): a falha
 *   server-side não vira 500 permanente; a mesma linha é reutilizada (sem
 *   colisão de PK) e o handler roda de novo — retry seguro do client.
 * - Existe com hash diferente -> erro de uso indevido (400).
 * - Duas inserções concorrentes (race check-then-insert) -> a perdedora detecta
 *   a colisão de PK, re-lê e devolve a resposta da vencedora (nunca 500).
 */
export async function withIdempotency<T>(
  endpoint: string,
  correlationId: string,
  requestBody: unknown,
  handler: () => Promise<{ status: number; body: T }>
): Promise<{ status: number; body: T }> {
  const requestHash = hashBody(requestBody);
  const now = new Date().toISOString();
  const existing = await db.query.idempotencyKeys.findFirst({
    where: eq(idempotencyKeys.correlationId, correlationId),
  });

  if (existing) {
    const expired = existing.expiresAt < now;
    if (existing.requestHash !== requestHash) {
      throw new AppError("validation_failed", 400, "correlationId reutilizado com corpo diferente.");
    }
    if (existing.status === "completed" && !expired) {
      return { status: existing.responseStatus ?? 200, body: JSON.parse(existing.responseBody ?? "null") };
    }
    if (existing.status === "processing" && !expired) {
      // "processing" — outra requisição idêntica já está em voo
      throw new AppError("validation_failed", 409, "Requisição já em processamento, aguarde.");
    }
    // "failed" ou expirado — retry: reusa a linha e reprocessa.
    await db
      .update(idempotencyKeys)
      .set({ status: "processing", responseStatus: null, responseBody: null })
      .where(eq(idempotencyKeys.correlationId, correlationId));
    return executeAndComplete(correlationId, handler);
  }

  try {
    await db.insert(idempotencyKeys).values({
      correlationId,
      endpoint,
      requestHash,
      status: "processing",
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    });
  } catch (err) {
    // 23505 = unique_violation do Postgres (PK/coluna única já existente).
    if (isUniqueViolation(err)) {
      // 1.4 — corrida check-then-insert: a outra requisição idêntica venceu.
      const row = await db.query.idempotencyKeys.findFirst({
        where: eq(idempotencyKeys.correlationId, correlationId),
      });
      if (row?.status === "completed") {
        return { status: row.responseStatus ?? 200, body: JSON.parse(row.responseBody ?? "null") };
      }
      if (row && row.requestHash !== requestHash) {
        throw new AppError("validation_failed", 400, "correlationId reutilizado com corpo diferente.");
      }
      throw new AppError("validation_failed", 409, "Requisição já em processamento, aguarde.");
    }
    throw err;
  }

  return executeAndComplete(correlationId, handler);
}

async function executeAndComplete<T>(
  correlationId: string,
  handler: () => Promise<{ status: number; body: T }>
): Promise<{ status: number; body: T }> {
  try {
    const result = await handler();
    await db
      .update(idempotencyKeys)
      .set({ status: "completed", responseStatus: result.status, responseBody: JSON.stringify(result.body) })
      .where(eq(idempotencyKeys.correlationId, correlationId));
    return result;
  } catch (err) {
    await db.update(idempotencyKeys).set({ status: "failed" }).where(eq(idempotencyKeys.correlationId, correlationId));
    throw err;
  }
}