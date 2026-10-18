/**
 * `POST /auth/refresh` e `POST /auth/logout` — sessão por dispositivo (§4).
 *
 * Rotação (decisão 2): cada refresh consome o token apresentado e devolve um
 * novo. O consumo é um CLAIM atômico (`claimAuthSession`), então dois cliques
 * simultâneos não criam duas sessões vivas — o segundo vê a linha já revogada.
 *
 * REUSO = o token reapresentado já estava revogado (ou seja, alguém tem uma
 * cópia do refresh antigo): a resposta é 401 e a FAMÍLIA inteira é revogada
 * (`rotated_from`), derrubando tanto o ladrão quanto o dono. A revogação roda em
 * transação PRÓPRIA e commitada — se estivesse na transação do `throw`, o
 * rollback apagaria a medida de segurança (mesmo desenho do incremento de
 * tentativas no login por PIN).
 *
 * Logout é idempotente: revoga o que existir e responde `{ok:true}` sempre.
 */
import { Errors } from "../../../domain/errors.js";
import type { IdentityDependencies } from "../ports/identity-dependencies.js";
import { REFRESH_TTL_MS, addMs, newId, nowIso, opaqueToken, sha256Hex } from "../identity-helpers.js";
import { signTenantToken } from "../identity-tokens.js";

export function createRefreshSessionUsecase(deps: IdentityDependencies) {
  async function refreshSession(input: { refreshToken: string }) {
    const scope = deps.tenant();
    const now = nowIso();
    const hash = sha256Hex(input.refreshToken);

    const claimed = await deps.uow.run(scope, (session) => session.identity.claimAuthSession(hash, now));
    if (!claimed) {
      const stale = await deps.uow.run(scope, (session) => session.identity.findAuthSessionByHash(hash));
      if (stale?.revokedAt) {
        // Reuso detectado: derruba a família inteira (linha + descendentes).
        await deps.uow.run(scope, (session) => session.identity.revokeAuthSessionFamily(stale.id, now));
      }
      throw Errors.unauthorized("Sessão expirada. Entre novamente.");
    }

    // A sessão é de UM tenant: refrescar em outro host não reconstrói os claims
    // (o JWT carrega `tenant`) — o vínculo é revisto do zero.
    if (claimed.tenantSlug !== scope.slug) {
      await deps.uow.run(scope, (session) => session.identity.revokeAuthSessionFamily(claimed.id, now));
      throw Errors.unauthorized("Sessão de outra loja. Entre novamente.");
    }

    const link = await deps.tenants.findLinkedUser(scope.slug, claimed.accountId);
    if (!link) {
      await deps.uow.run(scope, (session) => session.identity.revokeAllAuthSessions(claimed.accountId, now));
      throw Errors.unauthorized("Seu acesso a esta empresa foi removido. Entre novamente.");
    }

    const nextToken = opaqueToken();
    await deps.uow.run(scope, (session) =>
      session.identity.createAuthSession({
        id: newId(),
        accountId: claimed.accountId,
        refreshHash: sha256Hex(nextToken),
        tenantSlug: scope.slug,
        deviceId: claimed.deviceId,
        rotatedFrom: claimed.id,
        expiresAt: addMs(now, REFRESH_TTL_MS),
        now,
      }),
    );

    return {
      token: signTenantToken({ sub: link.userId, role: link.role, tenant: scope.slug }, deps.jwtSecret),
      refreshToken: nextToken,
    };
  }

  async function logoutSession(input: { refreshToken: string }) {
    await deps.uow.run(deps.tenant(), (session) =>
      session.identity.revokeAuthSessionByHash(sha256Hex(input.refreshToken), nowIso()),
    );
    return { ok: true as const };
  }

  return { refreshSession, logoutSession };
}

export type RefreshSessionUsecase = ReturnType<typeof createRefreshSessionUsecase>;
