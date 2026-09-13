import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { categories, products } from "../../infra/db/schema.js";

// Lê direto de category/product — nenhum catálogo duplicado (§04 "Decisões de arquitetura").
export async function getPublicMenuUsecase() {
  const activeCategories = await db.query.categories.findMany({
    where: eq(categories.active, true),
    orderBy: (c, { asc }) => asc(c.displayOrder),
  });

  const activeProducts = await db.query.products.findMany({
    where: eq(products.active, true),
    orderBy: (p, { asc }) => asc(p.name),
  });

  return {
    categories: activeCategories.map((c) => ({
      id: c.id,
      name: c.name,
      products: activeProducts
        .filter((p) => p.categoryId === c.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          price: p.price,
          variations: JSON.parse(p.variations),
        })),
    })),
  };
}
