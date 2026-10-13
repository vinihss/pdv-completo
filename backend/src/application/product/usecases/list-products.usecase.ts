/**
 * Caso de uso: listar produtos (catálogo).
 *
 * Cache `products:list:*` (TTL 120s), busca `unaccent ILIKE`, sorts
 * price_asc/price_desc/nome e N+1 evitado (categorias/grupos lidos de uma vez
 * e montados em mapas). Semântica idêntica à `listProductsUsecase` anterior.
 */
import type { ProductDependencies } from "../ports/product-dependencies.js";
import { ProductHelpers } from "../shared/product-helpers.js";

export type ListProductsInput = {
  categoryId?: string;
  active?: boolean;
  search?: string;
  sort?: string;
  limit: number;
  offset: number;
};

export class ListProductsUseCase {
  constructor(private readonly deps: ProductDependencies) {}

  async execute(input: ListProductsInput) {
    const key = ProductHelpers.productListKey(input);
    const cached = await this.deps.cache.get<{ data: unknown[]; total: number }>(key);
    if (cached) return cached;

    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const page = await session.catalog.listProducts(input);

      // N+1 evitado: categorias e grupos lidos de uma vez (mapas).
      const categoryNames = await session.catalog.listCategories();
      const groupNames = await session.catalog.listKitchenGroups();
      const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));
      const groupMap = new Map(groupNames.map((g) => [g.id, g.name]));

      const balances = await session.stock.balances(page.data.map((p) => p.id));

      const data = page.data.map((p) =>
        ProductHelpers.serialize(
          p,
          {
            categoryName: p.categoryId ? (catMap.get(p.categoryId) ?? null) : null,
            kitchenGroupName: p.kitchenGroupId ? (groupMap.get(p.kitchenGroupId) ?? null) : null,
          },
          balances.get(p.id) ?? 0,
        ),
      );
      const result = { data, total: page.total };
      await this.deps.cache.set(key, result, { ttl: 120 });
      return result;
    });
  }
}
