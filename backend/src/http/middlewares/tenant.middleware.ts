import type { FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { stores } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";

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
 * 1. Subdomínio do header `Host` (ex: `joao.labolabe.tech` → `joao`)
 * 2. Header `X-Store-ID` (para apps mobile/desktop)
 * 3. `req.authUser?.storeId` (se já autenticado)
 *
 * Lança `storeNotResolved` (404) se não resolver, ou `storeInactive` (403) se a store estiver suspensa/inativa.
 * Injeta `req.storeId` e `req.store` no request para uso downstream.
 *
 * Rotas públicas não precisam de store: health check, assets públicos.
 * Webhooks são processados normalmente (alguns podem precisar de store).
 */
export async function resolveTenantMiddleware(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Rotas públicas que não requerem resolução de store
  const publicPaths = ["/health", "/public/", "/uploads/"];
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
    throw Errors.storeNotResolved();
  }

  if (store.status === "suspended" || store.status === "inactive") {
    throw Errors.storeInactive();
  }

  req.storeId = store.id;
  req.store = store;
}