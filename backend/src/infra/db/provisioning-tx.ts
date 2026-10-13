import type { Tx } from "./client.js";
import { PostgresUserDeviceRepository } from "./postgres-repositories.js";

/**
 * Ponte transacional para o `updateUserUsecase` (ainda NÃO migrado para ports +
 * UoW): ele roda dentro de um `db.transaction` cru e precisa revogar os
 * aparelhos do usuário na MESMA transação da desativação.
 *
 * Delega ao adapter do port (`PostgresUserDeviceRepository.revokeAll`), então a
 * query é uma só — a duplicação que existia em `device-state.ts` sumiu. Quando
 * o `user.usecases` migrar para `TenantSession`, esta ponte pode ser removida e
 * o use case chama `session.userDevices.revokeAll` direto.
 */
export async function revokeAllDevicesTx(tx: Tx, userId: string, at: string): Promise<number> {
  return new PostgresUserDeviceRepository(tx).revokeAll(userId, at);
}
