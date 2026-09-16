import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { categories, products } from "../../infra/db/schema.js";
import { normalizeVariations } from "../product.usecases.js";

// Cardápio público expõe variações no formato do contrato §05
// (Record<grupo, opções[]>); sem grupo = null.
function publicVariations(rawVariations: string): Record<string, string[]> | null {
  // `variations` é text no SQLite (drizzle sem mode:'json') — parse antes de normalizar.
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(rawVariations);
  } catch {
    parsed = [];
  }
  const groups = normalizeVariations(parsed);
  if (groups.length === 0) return null;
  return Object.fromEntries(groups.map((g) => [g.name, g.options]));
}

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
          description: p.description,
          price: p.price,
          variations: publicVariations(p.variations),
          imagePath: p.imagePath ? `/uploads/${p.imagePath}` : null,
        })),
    })),
  };
}
