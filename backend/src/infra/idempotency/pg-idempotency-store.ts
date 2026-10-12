import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { AppError } from "../../domain/errors.js";
import type { IdempotencyStore } from "../../application/ports/effects.js";
import { db, type Db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { idempotencyKeys } from "../db/schema.js";

/**
 * Implementação Postgres do port `IdempotencyStore` (ports/effects.ts) — FASE 0.
 *
 * É a extração da lógica do middleware
 * `http/middlewares/idempotency.middleware.ts#withIdempotency` (fluxo da §10),
 * com a MESMA semântica, linha por linha:
 * - não existe → grava "processing", executa o handler, marca "completed";
 * - "completed" válido → devolve a resposta cacheada, sem reprocessar;
 * - "processing" válido → 409 (requisição concorrente idêntica em voo);
 * - "failed" ou `expires_at` expirado → REPROCESSA reusando a mesma linha
 *   (retry seguro do client, sem colisão de PK);
 * - hash (SHA-256 do corpo) diferente → 400 de uso indevido;
 * - corrida check-then-insert → a perdedora detecta a colisão de PK (23505),
 *   relê e devolve a resposta da vencedora (nunca 500).
 *
 * ## Relação com o middleware (por enquanto duplicada, de propósito)
 *
 * A onda desta tarefa foi instruída a NÃO alterar `http/` — o middleware
 * continua com a sua própria cópia da lógica e o comportamento externo não
 * muda. A próxima onda (injetar o port nos handlers) deve trocar o corpo do
 * `withIdempotency` por `new PgIdempotencyStore().execute({...})` e apagar a
 * cópia do middleware — até lá, as duas versões precisam permanecer iguais
 * (alterou uma, altere a outra).
 *
 * Roteamento de tenant: o default é o proxy `db` (ALS corrente), idêntico ao
 * do middleware — `idempotencyKeys` é tabela POR SCHEMA de tenant. Para uso
 * fora de um request (worker/webhook), injete `tenantDb(tenant.schemaName)`.
 */
const TTL_MS = 15 * 60_000;

function hashBody(body: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly database: Db = db) {}

  async execute<T>(input: {
    endpoint: string;
    correlationId: string;
    body: unknown;
    handler: () => Promise<{ status: number; body: T }>;
  }): Promise<{ status: number; body: T }> {
    const { endpoint, correlationId, handler } = input;
    const requestHash = hashBody(input.body);
    const now = new Date().toISOString();
    const existing = await this.database.query.idempotencyKeys.findFirst({
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
      await this.database
        .update(idempotencyKeys)
        .set({ status: "processing", responseStatus: null, responseBody: null })
        .where(eq(idempotencyKeys.correlationId, correlationId));
      return this.executeAndComplete(correlationId, handler);
    }

    try {
      await this.database.insert(idempotencyKeys).values({
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
        const row = await this.database.query.idempotencyKeys.findFirst({
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

    return this.executeAndComplete(correlationId, handler);
  }

  private async executeAndComplete<T>(
    correlationId: string,
    handler: () => Promise<{ status: number; body: T }>
  ): Promise<{ status: number; body: T }> {
    try {
      const result = await handler();
      await this.database
        .update(idempotencyKeys)
        .set({ status: "completed", responseStatus: result.status, responseBody: JSON.stringify(result.body) })
        .where(eq(idempotencyKeys.correlationId, correlationId));
      return result;
    } catch (err) {
      await this.database
        .update(idempotencyKeys)
        .set({ status: "failed" })
        .where(eq(idempotencyKeys.correlationId, correlationId));
      throw err;
    }
  }
}
