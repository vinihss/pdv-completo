/**
 * Catálogo — categorias. Ponto de entrada de COMPATIBILIDADE.
 *
 * A implementação foi decomposta em um Use Case por operação (Command Pattern
 * / Single Use Case Class) em `usecases/*.usecase.ts`, com as dependências em
 * `ports/category-dependencies.ts`, o helper de cache em
 * `shared/category-cache.ts` e o facade `CategoryModule` em
 * `category.module.ts`.
 *
 * Este arquivo mantém a factory `createCategoryUsecases` com os NOMES LEGADOS
 * (`listCategoriesUsecase`, ...) para a composition root
 * (`infra/composition/default-usecases.ts`), que re-exporta para as rotas.
 * Nada muda na assinatura observada de fora. Para uso novo, prefira
 * `CategoryModule` e `.listCategories.execute(...)`.
 *
 * Semântica preservada do módulo original:
 *   - `listCategoriesUsecase`: cache `categories:*` (TTL 300s) →
 *     `session.catalog.listCategories()` (ordem de exibição);
 *   - create/update/delete: 404 prévio (`findCategoryById`), escrita,
 *     audit e invalidação de `categories:*`/`products:*`/`public-menu`;
 *   - delete é EXCLUSÃO REAL (§7.5): produtos vinculados ficam com
 *     `category_id = null` até reatribuição (regra do adapter).
 */
import { CategoryModule } from "./category.module.js";
import type { CategoryDependencies } from "./ports/category-dependencies.js";
import type { CreateCategoryInput } from "./usecases/create-category.usecase.js";
import type { UpdateCategoryInput } from "./usecases/update-category.usecase.js";

export { CategoryModule };
export type { CategoryDependencies };
export type { CategoryUsecasesDeps } from "./ports/category-dependencies.js";
export { ListCategoriesUseCase } from "./usecases/list-categories.usecase.js";
export {
  CreateCategoryUseCase,
  type CreateCategoryInput,
} from "./usecases/create-category.usecase.js";
export {
  UpdateCategoryUseCase,
  type UpdateCategoryInput,
} from "./usecases/update-category.usecase.js";
export { DeleteCategoryUseCase } from "./usecases/delete-category.usecase.js";

export function createCategoryUsecases(deps: CategoryDependencies) {
  const module = new CategoryModule(deps);
  return {
    listCategoriesUsecase: () => module.listCategories.execute(),
    createCategoryUsecase: (input: CreateCategoryInput, actorId: string) =>
      module.createCategory.execute(input, actorId),
    updateCategoryUsecase: (id: string, input: UpdateCategoryInput, actorId: string) =>
      module.updateCategory.execute(id, input, actorId),
    deleteCategoryUsecase: (id: string, actorId: string) => module.deleteCategory.execute(id, actorId),
  };
}
