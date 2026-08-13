import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { idempotencyKeys } from "../../infra/db/schema.js";
import { AppError } from "../../domain/errors.js";

function hashBody(body: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * Implementa o fluxo de idempotência da §10:
 * - Não existe -> grava "processing", executa o handler, marca "completed".
 * - Existe e "completed" -> devolve a resposta cacheada, sem reprocessar.
 * - Existe e "processing" -> 409 (requisição concorrente idêntica em voo).
 * - Existe com hash diferente -> erro de uso indevido (400).
 */
export async function withIdempotency<T>(
  endpoint: string,
  correlationId: string,
  requestBody: unknown,
  handler: () => Promise<{ status: number; body: T }>
): Promise<{ status: number; body: T }> {
  const requestHash = hashBody(requestBody);
  const existing = await db.query.idempotencyKeys.findFirst({
    where: eq(idempotencyKeys.correlationId, correlationId),
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AppError("validation_failed", 400, "correlationId reutilizado com corpo diferente.");
    }
    if (existing.status === "completed") {
      return { status: existing.responseStatus ?? 200, body: JSON.parse(existing.responseBody ?? "null") };
    }
    // "processing" — outra requisição idêntica já está em voo
    throw new AppError("validation_failed", 409, "Requisição já em processamento, aguarde.");
  }

  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await db.insert(idempotencyKeys).values({
    correlationId,
    endpoint,
    requestHash,
    status: "processing",
    expiresAt,
  });

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
