import type { TenantSession } from "../ports/unit-of-work.js";

// Helpers transacionais compartilhados do provisioning, agora sobre os PORTS
// da sessão (`session.provisioningKeys`/`session.userDevices`) em vez de
// Drizzle direto. Ficam em módulo próprio para o `provisioning.usecases` e
// qualquer outro use case (ex.: cascata de desativação de usuário) usarem a
// MESMA régua sem importar schema/client. A cascata de desativação de usuário
// (`user.usecases`) chama `session.userDevices.revokeAll` direto.

/** Revoga a chave ativa anterior do usuário (rotação da chave). */
export async function revokeActiveKey(session: TenantSession, userId: string, at: string): Promise<void> {
  await session.provisioningKeys.revokeActive(userId, at);
}

/**
 * Revoga TODOS os aparelhos ativos do usuário (cascata da desativação).
 * Devolve quantos foram revogados, para entrar no audit/evento.
 */
export async function revokeAllDevices(session: TenantSession, userId: string, at: string): Promise<number> {
  return session.userDevices.revokeAll(userId, at);
}
