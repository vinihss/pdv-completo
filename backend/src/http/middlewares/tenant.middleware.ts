import type { FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { stores } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { verifyTokenRaw } from "./auth.middleware.js";

declare module "fastify" {
  interface FastifyRequest {
    storeId?: string;
    store?: typeof stores.$inferSelect;
  }
}

/**
 * Middleware de resolução de tenant (store) por subdomínio.
 *
 * Ordem de resolução:
 * 1. JWT do usuário autenticado (`Authorization: Bearer`, storeId no payload)
 * 2. Subdomínio do header `Host` (ex: `joao.labolabe.tech` → `joao`)
 * 3. Header `X-Store-ID` (para apps mobile/desktop)
 * 4. `req.authUser?.storeId` (se já autenticado)
 *
 * Lança `storeNotResolved` (404) se não resolver, ou `storeInactive` (403) se a store estiver suspensa/inativa.
 * Injeta `req.storeId` e `req.store` no request para uso downstream.
 *
 * Rotas públicas não precisam de store: health check, assets públicos.
 * Webhooks são processados normalmente (alguns podem precisar de store).
 */
export async function resolveTenantMiddleware(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Rotas públicas que não requerem resolução de store
  const publicPaths = ["/health", "/uploads/", "/internal/caddy-on-demand-tls"];
  const path = req.url ?? "";
  if (publicPaths.some((prefix) => path.startsWith(prefix))) {
    return;
  }

  const host = req.headers["host"];
  if (!host) {
    throw Errors.storeNotResolved();
  }

  // Extrai subdomínio: "joao.labolabe.tech" → "joao"
  // Remove port se presente (ex: "localhost:3000")
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");
  const subdomain = parts.length >= 3 ? parts[0] : null;
  const hasDerivableSubdomain = parts.length >= 3 && subdomain !== "www";

  // ---------- 1. JWT do usuário autenticado (tenant no token) ----------
  // O login embute storeId/storeSlug no JWT (ver login.usecase). Quando o
  // request traz um token válido, ele é a fonte do tenant — cobre desktop/
  // mobile (sem subdomínio) e deixa o backend independente do Host.
  // Se o Host ALSO aponta um subdomínio, o JWT precisa bater com ele:
  // usuário logado na loja A acessando o subdomínio da loja B é 403.
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = verifyTokenRaw(authHeader.slice("Bearer ".length));
      if (payload.storeId) {
        const byJwt = await db.query.stores.findFirst({
          where: eq(stores.id, payload.storeId),
        });
        if (byJwt) {
          if (hasDerivableSubdomain && byJwt.slug !== subdomain) {
            throw Errors.tenantMismatch();
          }
          if (byJwt.status === "suspended" || byJwt.status === "inactive") {
            throw Errors.storeInactive();
          }
          req.storeId = byJwt.id;
          req.store = byJwt;
          return;
        }
      }
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "tenant_mismatch") throw err;
      if (err && typeof err === "object" && (err as { code?: string }).code === "store_inactive") throw err;
      // Token inválido/expirado: segue o fluxo público. Nas rotas protegidas
      // o authMiddleware responde 401 depois — não é papel do tenant middleware.
    }
  }

  let store: typeof stores.$inferSelect | undefined;

  // 1. Tenta resolver por subdomínio
  if (subdomain) {
    store = await db.query.stores.findFirst({
      where: eq(stores.slug, subdomain),
    });
  }

  // 2. Fallback: header X-Store-ID
  if (!store) {
    const storeIdFromHeader = req.headers["x-store-id"] as string | undefined;
    if (storeIdFromHeader) {
      store = await db.query.stores.findFirst({
        where: eq(stores.id, storeIdFromHeader),
      });
    }
  }

  // 3. Fallback: usuário já autenticado com storeId
  if (!store && req.authUser?.storeId) {
    store = await db.query.stores.findFirst({
      where: eq(stores.id, req.authUser.storeId),
    });
  }

  if (!store) {
    // 4. Fallback: store "default" apenas quando não há subdomínio derivável
    //    (localhost, 127.0.0.1, *.localhost, apex do domínio) ou quando o
    //    subdomínio é "www". Subdomínio presente e desconhecido (ex.: "foo")
    //    continua 404, e X-Store-ID inválido não cai silenciosamente no
    //    fallback.
    const storeIdHeader = req.headers["x-store-id"] as string | undefined;
    const noDerivableSubdomain = parts.length < 3 || subdomain === "www";
    if (!storeIdHeader && noDerivableSubdomain) {
      store = await db.query.stores.findFirst({
        where: eq(stores.slug, "default"),
      });
    }
  }

  if (!store) {
    throw Errors.storeNotResolved();
  }

  if (store.status === "suspended" || store.status === "inactive") {
    throw Errors.storeInactive();
  }

  req.storeId = store.id;
  req.store = store;
}