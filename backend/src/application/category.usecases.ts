import { eq } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { categories, products } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { logAction } from "../infra/audit-log.js";

export async function listCategoriesUsecase() {
  return db.query.categories.findMany({ orderBy: (c, { asc }) => asc(c.displayOrder) });
}

export async function createCategoryUsecase(
  input: { name: string; displayOrder?: number },
  actorId: string
) {
  return db.transaction((tx) => {
    const row = tx
      .insert(categories)
      .values({ name: input.name, displayOrder: input.displayOrder ?? 0 })
      .returning()
      .get();
    logAction(tx, actorId, "category_created", null, { categoryId: row.id, name: row.name });
    return row;
  });
}

export async function updateCategoryUsecase(
  id: string,
  input: { name?: string; displayOrder?: number; active?: boolean },
  actorId: string
) {
  const existing = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!existing) throw Errors.notFound("Categoria");
  return db.transaction((tx) => {
    const row = tx
      .update(categories)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(categories.id, id))
      .returning()
      .get();
    logAction(tx, actorId, "category_updated", null, { categoryId: id, name: row.name });
    return row;
  });
}

// Exclusão real (categoria pode ser hard-deleted, diferente de produto — §7.5 nota de design).
// Produtos vinculados ficam com category_id nulo até reatribuição.
// Transação síncrona — ver nota em order.usecases.ts sobre o driver better-sqlite3.
export async function deleteCategoryUsecase(id: string, actorId: string) {
  const existing = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!existing) throw Errors.notFound("Categoria");
  db.transaction((tx) => {
    tx.update(products).set({ categoryId: null }).where(eq(products.categoryId, id)).run();
    tx.delete(categories).where(eq(categories.id, id)).run();
    logAction(tx, actorId, "category_deleted", null, { categoryId: id, name: existing.name });
  });
}