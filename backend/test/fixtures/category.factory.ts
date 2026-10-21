import { db } from "../../src/infra/db/client.js";
import { categories } from "../../src/infra/db/schema.js";

type InsertCategory = typeof categories.$inferInsert;
type SelectCategory = typeof categories.$inferSelect;

export async function createCategory(overrides: Partial<InsertCategory> = {}): Promise<SelectCategory> {
  const id = overrides.id ?? `cat-${crypto.randomUUID()}`;
  const category: InsertCategory = {
    id,
    name: overrides.name ?? "Bebidas",
    sortOrder: overrides.sortOrder ?? 0,
    active: overrides.active ?? true,
    ...overrides,
  };

  await db
    .insert(categories)
    .values(category)
    .onConflictDoUpdate({
      target: [categories.tenantId, categories.id],
      set: category,
    });

  return category as SelectCategory;
}
