/**
 * PATCH /categories/:id — update parcial de categoria.
 *
 * 404 prévio (`findCategoryById`), escrita, audit na MESMA transação e
 * invalidação do cache de catálogo.
 */
import type { CategoryRecord } from "../../ports/repositories.js";
import type { CategoryDependencies } from "../ports/category-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { invalidateCategoryRelated } from "../shared/category-cache.js";

export type UpdateCategoryInput = {
  name?: string;
  displayOrder?: number;
  active?: boolean;
};

export class UpdateCategoryUseCase {
  constructor(private readonly deps: CategoryDependencies) {}

  async execute(id: string, input: UpdateCategoryInput, actorId: string): Promise<CategoryRecord> {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.catalog.findCategoryById(id);
      if (!existing) throw Errors.notFound("Categoria");
      const row = await session.catalog.updateCategory(id, input);
      await session.audit.record({
        actorId,
        action: "category_updated",
        details: { categoryId: id, name: row.name },
      });
      await invalidateCategoryRelated(this.deps.cache);
      return row;
    });
  }
}
