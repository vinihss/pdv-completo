/**
 * DELETE /categories/:id — EXCLUSÃO REAL (§7.5).
 *
 * Produtos vinculados ficam com `category_id = null` até reatribuição (regra
 * do adapter). Audit na MESMA transação e invalidação do cache de catálogo.
 */
import type { CategoryDependencies } from "../ports/category-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { invalidateCategoryRelated } from "../shared/category-cache.js";

export class DeleteCategoryUseCase {
  constructor(private readonly deps: CategoryDependencies) {}

  async execute(id: string, actorId: string): Promise<void> {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.catalog.findCategoryById(id);
      if (!existing) throw Errors.notFound("Categoria");
      await session.catalog.deleteCategory(id);
      await session.audit.record({
        actorId,
        action: "category_deleted",
        details: { categoryId: id, name: existing.name },
      });
      await invalidateCategoryRelated(this.deps.cache);
    });
  }
}
