import type { IdempotencyStore } from "../../application/ports/effects.js";
import { PgIdempotencyStore } from "../../infra/idempotency/pg-idempotency-store.js";

/**
 * Idempotência de endpoints (§10) — a mesma para todos os handlers.
 *
 * A lógica (hash do corpo, janela de validade, corrida check-then-insert,
 * retry de `failed`/expirado) mora no `PgIdempotencyStore`, que fala o
 * banco pelo port `IdempotencyStore`. O middleware é a fachada de função:
 * os handlers chamam `withIdempotency(endpoint, correlationId, body, handler)`
 * sem conhecer Drizzle/schema/client (regra de camadas do arquitetura.test).
 *
 * O comportamento é idêntico ao da cópia que existia aqui — a extração foi
 * feita antes e esta troca só apaga a duplicação. Alterou a semântica, mude
 * em `PgIdempotencyStore`.
 */
const store: IdempotencyStore = new PgIdempotencyStore();

export function withIdempotency<T>(
  endpoint: string,
  correlationId: string,
  requestBody: unknown,
  handler: () => Promise<{ status: number; body: T }>
): Promise<{ status: number; body: T }> {
  return store.execute({ endpoint, correlationId, body: requestBody, handler });
}
