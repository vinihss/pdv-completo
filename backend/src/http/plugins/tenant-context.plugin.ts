import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { ResolvedTenant } from "../../application/tenant/resolve-tenant.usecase.js";
import { ensureTenantScope, enterTenantScope, exitTenantScope } from "../../infra/db/tenant-context.js";

const NO_TENANT_RESOLVE = new Set(["/health", "/internal/caddy-on-demand-tls", "/public/tenants/resolve"]);

export interface TenantContextOptions {
  /** Resolve o tenant a partir do host cru (header ou hostname). */
  resolveTenant: (rawHost: string | undefined) => Promise<ResolvedTenant>;
}

async function tenantContextPlugin(app: FastifyInstance, options: TenantContextOptions) {
    // Hook definitivo para interceptação e envelopamento do handler com o escopo do ALS
    app.addHook("onRoute", (routeOptions) => {
        const originalHandler = routeOptions.handler as any;

        if (NO_TENANT_RESOLVE.has(routeOptions.url.split("?")[0])) {
            return;
        }

        const isWebsocket =
            (routeOptions as any).websocket === true || typeof (routeOptions as any).wsHandler === "function";

        if (isWebsocket) {
            routeOptions.handler = async function (socket: any, req: any) {
                const host = req?.headers?.["x-tenant-host"] || req?.headers?.host || req?.hostname;
                return ensureTenantScope(host, () => originalHandler(socket, req));
            } as any;
            return;
        }

        routeOptions.handler = async function (req: any, reply: any) {
            const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
            return ensureTenantScope(host, () => originalHandler(req, reply));
        } as any;
    });

    // Inicialização e limpeza do escopo por ciclo de request/response
    app.addHook("onRequest", async (req) => {
        if (NO_TENANT_RESOLVE.has(req.url.split("?")[0])) return;
        const rawHost = req.headers["x-tenant-host"] ?? req.hostname;
        const tenant = await options.resolveTenant(typeof rawHost === "string" ? rawHost : undefined);
        enterTenantScope({ schemaName: tenant.schemaName, slug: tenant.slug, isDefault: tenant.isDefault });
    });

    app.addHook("onResponse", async () => {
        exitTenantScope();
    });
}

// O uso do fastify-plugin evita que o Fastify crie um novo escopo isolado
// de contexto. `resolveTenant` chega injetada pela composition root.
export const tenantContext = fp(tenantContextPlugin);
