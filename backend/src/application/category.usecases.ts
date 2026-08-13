import { eq } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { categories, products } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";

export async function listCategoriesUsecase() {
  return db.query.categories.findMany({ orderBy: (c, { asc }) => asc(c.displayOrder) });
}

export async function createCategoryUsecase(input: { name: string; displayOrder?: number }) {
  const [created] = await db
    .insert(categories)
    .values({ name: input.name, displayOrder: input.displayOrder ?? 0 })
    .returning();
  return created;
}

export async function updateCategoryUsecase(id: string, input: { name?: string; displayOrder?: number }) {
  const existing = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!existing) throw Errors.notFound("Categoria");
  const [updated] = await db
    .update(categories)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
    })
    .where(eq(categories.id, id))
    .returning();
  return updated;
}

// Exclusão real (categoria pode ser hard-deleted, diferente de produto — §7.5 nota de design).
// Produtos vinculados ficam com category_id nulo até reatribuição.
// Transação síncrona — ver nota em order.usecases.ts sobre o driver better-sqlite3.
export async function deleteCategoryUsecase(id: string) {
  const existing = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!existing) throw Errors.notFound("Categoria");
  db.transaction((tx) => {
    tx.update(products).set({ categoryId: null }).where(eq(products.categoryId, id)).run();
    tx.delete(categories).where(eq(categories.id, id)).run();
  });
}
