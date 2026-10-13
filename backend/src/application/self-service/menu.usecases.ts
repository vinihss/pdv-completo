/**
 * Cardápio público (self-service). ONDA 3A.
 *
 * Factory pura (`createMenuUsecases`): sem Drizzle/infra. Leitura
 * via `session.catalog` dentro do Unit-of-Worker (snapshot
 * consistente de categorias + produtos).
 *
 * Semântica preservada:
 *   - lê DIRETO de category/product — nenhum catálogo duplicado
 *     (§04 "Decisões de arquitetura");
 *   - variações expostas no MESMO formato do payload interno
 *     (`VariationGroup[]`: name/options/required/allowMultiple) —
 *     o cliente precisa de `required` pra não aceitar pedido sem
 *     opção obrigatória (ex.: ponto da carne) e de `allowMultiple`
 *     pra grupos de extras. Sem grupo = null;
 *   - vitrine: a página monta a seção "Destaques" com os
 *     marcados (`featured`) — o produto continua na sua
 *     categoria (docs/04).
 */
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import { parseVariations, type VariationGroup } from "../../domain/variations.js";

function publicVariations(rawVariations: string): VariationGroup[] | null {
  const groups = parseVariations(rawVariations);
  return groups.length === 0 ? null : groups;
}

/**
 * `/uploads/product/<filename>` — mesmo formato de
 * `storageAssetPath("product", ...)` de `infra/storage`. Definido
 * aqui (em vez de importar infra) porque a application não
 * depende da camada de armazenamento: a URL é derivação pura do
 * nome de arquivo já persistido.
 */
const UPLOADS_PREFIX = "/uploads";
function productImageUrl(imagePath: string | null): string | null {
  return imagePath ? `${UPLOADS_PREFIX}/product/${imagePath}` : null;
}

export interface MenuUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

export function createMenuUsecases(deps: MenuUsecasesDeps) {
  return {
    async getPublicMenuUsecase() {
      return deps.uow.run(deps.tenant(), async (session) => {
        const activeCategories = await session.catalog.listActiveCategories();
        const activeProducts = await session.catalog.listActiveProducts();

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
                imagePath: productImageUrl(p.imagePath),
                featured: p.featured,
              })),
          })),
        };
      });
    },
  };
}
