/**
 * GET /categories — categorias em ordem de exibição.
 *
 * Cache `categories:*` (TTL 300s) antes da transação; no miss, lê pelo port
 * `session.catalog` e reabastece o cache.
 */
import type { CategoryRecord } from "../../ports/repositories.js";
import type { CategoryDependencies } from "../ports/category-dependencies.js";

export class ListCategoriesUseCase {
  constructor(private readonly deps: CategoryDependencies) {}

  async execute(): Promise<CategoryRecord[]> {
    const cached = await this.deps.cache.get<CategoryRecord[]>("categories:*");
    if (cached) return cached;
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const rows = await session.catalog.listCategories();
      await this.deps.cache.set("categories:*", rows, { ttl: 300 });
      return rows;
    });
  }
}
