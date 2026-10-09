import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { Errors } from "../../domain/errors.js";
import { resolveTenantSchemaInScope } from "../db/tenant-context.js";

// Revogação de sessão aberta (docs/21 §5.4): o JWT é stateless (12h), então
// "desativar usuário" não matava sessões vivas. O authMiddleware passa a
// verificar `user.active` em toda requisição, com cache em memória de ~30s —
// corte efetivo em segundos, a custo de no máximo uma query indexada por
// usuário a cada janela. Resultado negativo (usuário inexistente) também é
// cacheado: sessão de usuário que não existe mais não merece retry a cada
// request.
//
// Mora em `infra/` (e não no middleware) porque o `updateUserUsecase` precisa
// invalidar o cache do usuário desativado NA MESMA transação da escrita — o
// `application` não pode importar de `http`, e o cache de ~30s não pode ficar
// mentindo depois de um toggle explícito de desativação.

const TTL_MS = 30_000;
const cache = new Map<string, { active: boolean; at: number }>();

// Chave particionada por schema de tenant: o id do usuário só é único dentro
// da loja (o `system` e ids de seed repetem entre tenants), então a chave crua
// faria o `active` de uma loja vazar para outra por até 30s.
function cacheKey(userId: string): string {
  return `${resolveTenantSchemaInScope()}:${userId}`;
}

/** Invalida o cache de UM usuário (chamado ao desativar/reativar). */
export function invalidateActiveUser(userId: string): void {
  cache.delete(cacheKey(userId));
}

/** Zera o cache inteiro — usado pela suíte de testes entre casos. */
export function clearActiveUserCache(): void {
  cache.clear();
}

/**
 * Garante que o usuário existe e está `active`. Joga `AppError` 401
 * (`unauthorized`) quando não — a mesma resposta de token inválido, para não
 * revelar o motivo da sessão ter caído.
 */
export async function assertUserActive(userId: string): Promise<void> {
  const now = Date.now();
  const key = cacheKey(userId);
  const cached = cache.get(key);
  if (cached && now - cached.at < TTL_MS) {
    if (!cached.active) throw Errors.unauthorized();
    return;
  }
  const [row] = await db
    .select({ active: users.active })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const active = row?.active === true;
  cache.set(key, { active, at: now });
  if (!active) throw Errors.unauthorized();
}