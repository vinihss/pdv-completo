import { auditLog } from "./db/schema.js";

/**
 * Grava no audit_log dentro da mesma transação da operação principal (§13).
 * Síncrona de propósito: dentro de `db.transaction(cb)` do driver better-sqlite3
 * (SQLite é fundamentalmente síncrono), o callback da transação não pode
 * retornar uma Promise — por isso todo o código que roda dentro de uma
 * transação (aqui, no outbox e nos usecases) evita `async/await` e usa os
 * métodos terminais síncronos do Drizzle (`.run()`, `.get()`, `.all()`).
 */
export function logAction(
  tx: any,
  userId: string,
  action: string,
  orderId: string | null,
  details: object = {}
) {
  tx.insert(auditLog).values({ userId, action, orderId, details: JSON.stringify(details) }).run();
}
