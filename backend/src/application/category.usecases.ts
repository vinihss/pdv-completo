import { eq } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { categories, products } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { logAction } from "../infra/audit-log.js";
import { tenantCache } from "../infra/cache/index.js";

// Cache particionado por schema: `categories:*`/`products:*`/`public-menu`
// são dados de uma loja só.
const cache = tenantCache;

async function invalidateCategoryRelated() {
  await cache.invalidatePattern("categories:*");
  await cache.invalidatePattern("products:*");
  await cache.invalidatePattern("public-menu");
}

export async function listCategoriesUsecase() {
  const cached = await cache.get("categories:*");
  if (cached) return cached;
  const rows = await db.query.categories.findMany({ orderBy: (c, { asc }) => asc(c.displayOrder) });
  await cache.set("categories:*", rows, { ttl: 300 });
  return rows;
}

export async function createCategoryUsecase(
  input: { name: string; displayOrder?: number },
  actorId: string
) {
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(categories)
      .values({ name: input.name, displayOrder: input.displayOrder ?? 0 })
      .returning();
    await logAction(tx, actorId, "category_created", null, { categoryId: r.id, name: r.name });
    await invalidateCategoryRelated();
    return r;
  });
  return row;
}

export async function updateCategoryUsecase(
  id: string,
  input: { name?: string; displayOrder?: number; active?: boolean },
  actorId: string
) {
  const existing = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!existing) throw Errors.notFound("Categoria");
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .update(categories)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(categories.id, id))
      .returning();
    await logAction(tx, actorId, "category_updated", null, { categoryId: id, name: r.name });
    await invalidateCategoryRelated();
    return r;
  });
  return row;
}

// Exclusão real (categoria pode ser hard-deleted, diferente de produto — §7.5 nota de design).
// Produtos vinculados ficam com category_id nulo até reatribuição.
// Transação assíncrona — ver nota em order.usecases.ts.
export async function deleteCategoryUsecase(id: string, actorId: string) {
  const existing = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!existing) throw Errors.notFound("Categoria");
  await db.transaction(async (tx) => {
    await tx.update(products).set({ categoryId: null }).where(eq(products.categoryId, id));
    await tx.delete(categories).where(eq(categories.id, id));
    await logAction(tx, actorId, "category_deleted", null, { categoryId: id, name: existing.name });
    await invalidateCategoryRelated();
  });
}