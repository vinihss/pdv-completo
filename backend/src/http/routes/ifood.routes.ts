import type { FastifyInstance } from "fastify";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { isIfoodEnabled, isIfoodMock, ifoodConfig } from "../../integrations/ifood/config.js";
import {
  getIfoodState,
  ifoodStateKeys,
} from "../../integrations/ifood/state.js";
import { db } from "../../infra/db/client.js";
import { ifoodEvents, orders } from "../../infra/db/schema.js";
import { eq, sql } from "drizzle-orm";
import { syncCatalogUsecase } from "../../integrations/ifood/catalog-sync.js";

// Painel do gerente: estado da integração iFood (conexão, worker, eventos).
// GET /ifood/status — apenas gerente (spec: ferramenta de gerência).
export async function ifoodRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);
  app.addHook("preHandler", requireRole("manager"));

  app.get("/ifood/status", async () => {
    const merchantId = getIfoodState(ifoodStateKeys.merchantId);
    const eventCounts = (
      await db
        .select({ status: ifoodEvents.status, count: sql<number>`count(*)` })
        .from(ifoodEvents)
        .groupBy(ifoodEvents.status)
    ).reduce((acc: Record<string, number>, r) => ({ ...acc, [r.status]: r.count }), {});

    const ifoodOrderCount = (
      await db.select({ count: sql<number>`count(*)` }).from(orders).where(eq(orders.channel, "ifood"))
    )[0]?.count;

    return {
      enabled: isIfoodEnabled(),
      mock: isIfoodMock(),
      merchantId,
      merchantName: getIfoodState(ifoodStateKeys.merchantName) ?? null,
      lastPollAt: getIfoodState(ifoodStateKeys.lastPollAt) ?? null,
      lastPollError: getIfoodState(ifoodStateKeys.lastPollError) ?? null,
      lastCatalogSyncAt: getIfoodState(ifoodStateKeys.lastCatalogSyncAt) ?? null,
      pollingIntervalMs: ifoodConfig.pollingIntervalMs,
      ordersIngested: ifoodOrderCount ?? 0,
      events: eventCounts,
    };
  });

  // Sincroniza o cardápio local (produtos/categorias habilitados p/ iFood)
  // com o catálogo do marketplace. UPSERT idempotente.
  app.post("/ifood/catalog-sync", async () => {
    return syncCatalogUsecase();
  });
}