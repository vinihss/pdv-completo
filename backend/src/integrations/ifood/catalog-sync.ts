import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { categories, products } from "../../infra/db/schema.js";
import { ifoodConfig, isIfoodEnabled } from "./config.js";
import { ifoodFetch } from "./client.js";
import { resolveMerchantIfNeeded, getMerchantId, setIfoodState, ifoodStateKeys } from "./state.js";
import { Errors } from "../../domain/errors.js";

// Sync do catálogo local → iFood (Catalog v2.0). Modelo de mapeamento:
//   item.id          = product.ifood_sku (chave estável do marketplace)
//   item.externalCode = product.ifood_sku (usado na ingestão de pedidos)
//   item.category     = categoria local (criada no catálogo DEFAULT se faltar)
//   item.status       = AVAILABLE quando product.ifood_enabled && product.active
// Categorias e itens são UPSERT (PUT) → idempotente, roda a qualquer momento.

interface CatalogEntry {
  catalogId: string;
  context: string[];
  status: string;
}
interface IfoodCategory {
  id: string;
  name: string;
}
interface ItemSummary {
  sent: number;
  categoryCreated: number;
  unavailable: number;
}

export async function syncCatalogUsecase(): Promise<{
  merchantId: string;
  catalogId: string;
  categories: number;
  items: ItemSummary;
  syncedAt: string;
}> {
  if (!isIfoodEnabled()) throw Errors.notFound("integração iFood habilitada (env/credenciais)");

  await resolveMerchantIfNeeded();
  const merchantId = await getMerchantId();
  if (!merchantId) throw Errors.notFound("merchant iFood");

  const base = ifoodConfig.catalogUrl(merchantId);
  const catalogs = await ifoodFetch<CatalogEntry[]>(`${base}/catalogs`);
  const catalog = catalogs?.find((c) => (c.context ?? []).includes("DEFAULT")) ?? catalogs?.[0];
  if (!catalog?.catalogId) throw Errors.notFound("catálogo DEFAULT do iFood");

  // 1. Categorias: garante que cada categoria local ativa exista no iFood.
  const localCategories = await db
    .select()
    .from(categories)
    .where(eq(categories.active, true))
    .orderBy(categories.displayOrder);
  const existing = await ifoodFetch<IfoodCategory[]>(`${base}/catalogs/${catalog.catalogId}/categories`);

  const nameToIfoodId = new Map<string, string>();
  for (const c of existing ?? []) if (c.name) nameToIfoodId.set(c.name, c.id);

  let categoryCreated = 0;
  for (const local of localCategories) {
    if (!nameToIfoodId.has(local.name)) {
      const created = await ifoodFetch<IfoodCategory>(`${base}/catalogs/${catalog.catalogId}/categories`, {
        method: "POST",
        body: { name: local.name, template: "DEFAULT" },
      });
      nameToIfoodId.set(local.name, created?.id ?? "");
      categoryCreated++;
    }
  }

  // 2. Itens: UPSERT de todos os produtos habilitados pro iFood.
  const toSync = await db
    .select()
    .from(products)
    .where(eq(products.ifoodEnabled, true));
  const payload: Array<Record<string, unknown>> = [];
  let unavailable = 0;

  for (const p of toSync) {
    const sku = p.ifoodSku || p.id; // sem SKU definido, usa o id interno (estável)
    const localCat = p.categoryId
      ? await db.query.categories.findFirst({ where: eq(categories.id, p.categoryId) })
      : null;
    const iFoodCategoryId = localCat ? nameToIfoodId.get(localCat.name) : undefined;
    const available = Boolean(p.active);
    if (!available) unavailable++;

    payload.push({
      id: sku,
      externalCode: sku,
      internalId: p.id,
      name: p.name,
      description: p.description || undefined,
      price: { value: p.price },
      status: available ? "AVAILABLE" : "UNAVAILABLE",
      ...(iFoodCategoryId ? { category: { id: iFoodCategoryId } } : {}),
    });
  }

  const syncedAt = new Date().toISOString();

  // Envia em lotes (limite do iFood: 1000 itens por request).
  const CHUNK = 1000;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    await ifoodFetch(`${base}/items`, { method: "PUT", body: { items: chunk } });
  }

  await setIfoodState(ifoodStateKeys.lastCatalogSyncAt, syncedAt);
  await setIfoodState(ifoodStateKeys.lastCatalogSyncError, "");

  return {
    merchantId,
    catalogId: catalog.catalogId,
    categories: nameToIfoodId.size,
    items: { sent: payload.length, categoryCreated, unavailable },
    syncedAt,
  };
}