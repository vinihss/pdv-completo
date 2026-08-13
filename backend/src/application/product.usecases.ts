import { and, eq, sql } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { products } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";

function serialize(p: typeof products.$inferSelect) {
  return {
    id: p.id,
    categoryId: p.categoryId,
    name: p.name,
    price: p.price,
    variations: JSON.parse(p.variations),
    active: p.active,
    createdAt: p.createdAt,
  };
}

export async function listProductsUsecase(input: {
  categoryId?: string;
  active?: boolean;
  limit: number;
  offset: number;
}) {
  const conditions = [];
  if (input.categoryId) conditions.push(eq(products.categoryId, input.categoryId));
  if (input.active !== undefined) conditions.push(eq(products.active, input.active));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db.query.products.findMany({
    where,
    limit: input.limit,
    offset: input.offset,
    orderBy: (p, { asc }) => asc(p.name),
  });
  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(products).where(where as any);
  return { data: rows.map(serialize), total: totalRow[0]?.count ?? rows.length };
}

export async function createProductUsecase(input: {
  categoryId: string;
  name: string;
  price: number;
  variations?: unknown[];
}) {
  if (input.price < 0) throw Errors.validationFailed({ field: "price" });
  const [created] = await db
    .insert(products)
    .values({
      categoryId: input.categoryId,
      name: input.name,
      price: input.price,
      variations: JSON.stringify(input.variations ?? []),
    })
    .returning();
  return serialize(created);
}

export async function updateProductUsecase(
  id: string,
  input: { categoryId?: string; name?: string; price?: number; variations?: unknown[] }
) {
  if (input.price !== undefined && input.price < 0) throw Errors.validationFailed({ field: "price" });
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");

  const [updated] = await db
    .update(products)
    .set({
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.variations !== undefined ? { variations: JSON.stringify(input.variations) } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(products.id, id))
    .returning();
  return serialize(updated);
}

export async function setProductActiveUsecase(id: string, active: boolean) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");
  const [updated] = await db
    .update(products)
    .set({ active, updatedAt: new Date().toISOString() })
    .where(eq(products.id, id))
    .returning();
  return serialize(updated);
}
