import { db } from "../../src/infra/db/client.js";
import { products } from "../../src/infra/db/schema.js";
import { createCategory } from "./category.factory.js";
import { createKitchenGroup } from "./kitchen-group.factory.js";

type InsertProduct = typeof products.$inferInsert;
type SelectProduct = typeof products.$inferSelect;

export async function createProduct(overrides: Partial<InsertProduct> = {}): Promise<SelectProduct> {
  const id = overrides.id ?? `p-${crypto.randomUUID()}`;

  let categoryId = overrides.categoryId;
  if (!categoryId) {
    const defaultCat = await createCategory({ id: `cat-auto-${id}`, name: "Categoria Padrão" });
    categoryId = defaultCat.id;
  }

  let kitchenGroupId = overrides.kitchenGroupId;
  if (kitchenGroupId === undefined) {
    const defaultKg = await createKitchenGroup({ id: `kg-auto-${id}`, name: "Cozinha Padrão" });
    kitchenGroupId = defaultKg.id;
  }

  const product: InsertProduct = {
    id,
    name: overrides.name ?? "Produto Teste",
    price: overrides.price ?? 10.0,
    costPrice: overrides.costPrice ?? 5.0,
    categoryId,
    kitchenGroupId,
    active: overrides.active ?? true,
    description: overrides.description ?? "",
    variations: overrides.variations ?? "[]",
    ...overrides,
  };

  await db
    .insert(products)
    .values(product)
    .onConflictDoUpdate({
      target: [products.tenantId, products.id],
      set: product,
    });

  return product as SelectProduct;
}
