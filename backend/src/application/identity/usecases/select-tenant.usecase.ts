/**
 * `POST /auth/select-tenant` — troca o `accountToken` pela sessão de tenant (§4).
 *
 * Regras:
 * - conta suspensa → 401;
 * - `must_change_password` → **401 `password_change_required`**: a senha
 *   temporária não abre sessão de loja, o `accountToken` só serve para trocar a
 *   senha (decisão 8);
 * - sem vínculo ativo naquela loja → **403 `tenant_not_linked`** (a distinção
 *   entre "loja não existe", "suspensa" e "sem vínculo" NÃO vaza);
 * - sucesso: JWT de tenant no formato atual `{sub, role, tenant}` (12h) + refresh
 *   opaco de 30 dias (o banco guarda só o SHA-256).
 */
import { Errors } from "../../../domain/errors.js";
import { photoUrl } from "../../user/shared/user-helpers.js";
import type { IdentityDependencies } from "../ports/identity-dependencies.js";
import { REFRESH_TTL_MS, addMs, newId, nowIso, opaqueToken, sha256Hex } from "../identity-helpers.js";
import { signTenantToken } from "../identity-tokens.js";

export function createSelectTenantUsecase(deps: IdentityDependencies) {
  async function selectTenant(input: { accountId: string; slug: string }) {
    const tenant = deps.tenant();
    const slug = String(input.slug ?? "").trim().toLowerCase();

    const account = await deps.uow.run(tenant, (session) => session.identity.findAccountById(input.accountId));
    if (!account || account.status !== "active") {
      throw Errors.unauthorized("Conta não encontrada ou suspensa.");
    }
    if (account.mustChangePassword) throw Errors.passwordChangeRequired();

    const link = await deps.tenants.findLinkedUser(slug, account.id);
    if (!link) throw Errors.tenantNotLinked(slug);

    const now = nowIso();
    const refreshToken = opaqueToken();
    await deps.uow.run(tenant, (session) =>
      session.identity.createAuthSession({
        id: newId(),
        accountId: account.id,
        refreshHash: sha256Hex(refreshToken),
        tenantSlug: slug,
        expiresAt: addMs(now, REFRESH_TTL_MS),
        now,
      }),
    );

    return {
      token: signTenantToken({ sub: link.userId, role: link.role, tenant: slug }, deps.jwtSecret),
      refreshToken,
      user: {
        id: link.userId,
        name: link.name,
        role: link.role,
        photoPath: photoUrl(link.photoPath, "user"),
      },
    };
  }

  return { selectTenant };
}

export type SelectTenantUsecase = ReturnType<typeof createSelectTenantUsecase>;
