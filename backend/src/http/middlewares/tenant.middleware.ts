import { enterTenantScope, hasTenantScope } from "../../infra/db/tenant-context.js";
import type { ResolvedTenant } from "../../application/tenant/resolve-tenant.usecase.js";

/**
 * Pre-handler global que garante que o escopo de tenant está ativo no
 * ALS antes de qualquer route handler ser executado.
 * - Resolve o tenant pelo header Host (padrão) ou pelo hostname.
 * - Se já houver ALS populado, mantém o scope corrente.
 * - Se não, resolve e entra no scope. Lança 404 se o host não for
 *   reconhecido.
 *
 * `resolveTenant` é injetada pela composition root (Onda 7) — o
 * middleware não importa mais o root. Retorna a função de middleware
 * pronta para `app.use()`.
 */
export function createTenantMiddleware(
  resolveTenant: (rawHost: string) => Promise<ResolvedTenant>
) {
  return async function tenantMiddleware(
    request: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    next: (err?: any) => void
  ): Promise<void> {
    // Se já houver scope ativo (ALS), não re-resolve — mantém o
    // tenant corrente.
    if (hasTenantScope()) {
      return next();
    }

    const rawHost = (request.headers["x-tenant-host"] as string | undefined) ??
      request.hostname;

    if (!rawHost) {
      return reply.status(400).send({ error: { code: "bad_request", message: "Host header required for tenant resolution" } });
    }

    try {
      const tenant = await resolveTenant(rawHost);
      enterTenantScope({ schemaName: tenant.schemaName, slug: tenant.slug, isDefault: tenant.isDefault });
    } catch (err: any) {
      if (err.code === "tenant_not_resolved") {
        return reply.status(404).send({ error: { code: "tenant_not_resolved", message: "Loja não encontrada para este endereço." } });
      }
      if (err.code === "tenant_inactive") {
        return reply.status(403).send({ error: { code: "tenant_inactive", message: "Esta loja está inativa." } });
      }
      throw err;
    }

    next();
  };
}
