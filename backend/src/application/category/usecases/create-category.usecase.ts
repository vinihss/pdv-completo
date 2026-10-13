/**
 * POST /categories — cria categoria.
 *
 * Escrita via `session.catalog`, audit na MESMA transação e invalidação do
 * cache de catálogo (`categories:*`/`products:*`/`public-menu`).
 */
import type { CategoryRecord } from "../../ports/repositories.js";
import type { CategoryDependencies } from "../ports/category-dependencies.js";
import { invalidateCategoryRelated } from "../shared/category-cache.js";

export type CreateCategoryInput = {
  name: string;
  displayOrder?: number;
};

export class CreateCategoryUseCase {
  constructor(private readonly deps: CategoryDependencies) {}

  async execute(input: CreateCategoryInput, actorId: string): Promise<CategoryRecord> {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const row = await session.catalog.createCategory(input);
      await session.audit.record({
        actorId,
        action: "category_created",
        details: { categoryId: row.id, name: row.name },
      });
      await invalidateCategoryRelated(this.deps.cache);
      return row;
    });
  }
}
