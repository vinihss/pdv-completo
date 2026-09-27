import { auditLog } from "./db/schema.js";
import type { Tx } from "./db/client.js";

/**
 * Grava no audit_log dentro da mesma transação da operação principal (§13).
 *
 * Assíncrona porque o Postgres é: `tx.insert(...)` precisa ser awaited para
 * a escrita ter sido gravada antes do commit. Todo caller dentro de uma
 * transação tem que fazer `await logAction(tx, ...)` — sem o await, o INSERT
 * pode ser emitido depois do COMMIT e o registro se perder.
 */
export async function logAction(
  tx: Tx,
  userId: string,
  action: string,
  orderId: string | null,
  details: object = {},
): Promise<void> {
  await tx.insert(auditLog).values({ userId, action, orderId, details: JSON.stringify(details) });
}
