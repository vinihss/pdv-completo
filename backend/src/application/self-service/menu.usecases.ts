import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { categories, products } from "../../infra/db/schema.js";
import { parseVariations, type VariationGroup } from "../../domain/variations.js";

// Cardápio público expõe as variações no MESMO formato do payload interno de
// produto (`VariationGroup[]`: name/options/required/allowMultiple) — o cliente
// precisa de `required` pra não aceitar pedido sem opção obrigatória (ex.: ponto
// da carne) e de `allowMultiple` pra grupos de extras. Sem grupo = null.
function publicVariations(rawVariations: string): VariationGroup[] | null {
  const groups = parseVariations(rawVariations);
  return groups.length === 0 ? null : groups;
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
          // Vitrine: a página monta a seção "Destaques" com os marcados
          // (o produto continua na sua categoria — docs/04).
          featured: p.featured,
        })),
    })),
  };
}
