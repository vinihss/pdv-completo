import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../infra/db/client.js";
import { provisioningKeys, userDevices } from "../../infra/db/schema.js";

// Helpers transacionais compartilhados do provisioning. Ficam em módulo
// próprio (e não dentro de provisioning.usecases.ts) para o
// `updateUserUsecase` (user.usecases.ts) revogar os aparelhos do usuário na
// MESMA transação da desativação sem criar ciclo de import entre os dois
// arquivos de usecase: `user.usecases` → `device-state` → (schema/client)
// apenas.

/** Revoga a chave ativa anterior do usuário (rotação da chave). */
export async function revokeActiveKeyTx(tx: Tx, userId: string, at: string): Promise<void> {
  await tx
    .update(provisioningKeys)
    .set({ revokedAt: at, updatedAt: at })
    .where(and(eq(provisioningKeys.userId, userId), isNull(provisioningKeys.revokedAt)));
}

/**
 * Revoga TODOS os aparelhos ativos do usuário (cascata da desativação).
 * Devolve quantos foram revogados, para entrar no audit/evento.
 */
export async function revokeAllDevicesTx(tx: Tx, userId: string, at: string): Promise<number> {
  const rows = await tx
    .update(userDevices)
    .set({ active: false, revokedAt: at, updatedAt: at })
    .where(and(eq(userDevices.userId, userId), eq(userDevices.active, true)))
    .returning({ id: userDevices.id });
  return rows.length;
}