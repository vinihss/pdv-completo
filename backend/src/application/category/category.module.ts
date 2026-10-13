/**
 * Módulo de categorias — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências (injetado
 * via construtor) e expõe as instâncias como propriedades readonly.
 */
import type { CategoryDependencies } from "./ports/category-dependencies.js";
import { ListCategoriesUseCase } from "./usecases/list-categories.usecase.js";
import { CreateCategoryUseCase } from "./usecases/create-category.usecase.js";
import { UpdateCategoryUseCase } from "./usecases/update-category.usecase.js";
import { DeleteCategoryUseCase } from "./usecases/delete-category.usecase.js";

export class CategoryModule {
  public readonly listCategories: ListCategoriesUseCase;
  public readonly createCategory: CreateCategoryUseCase;
  public readonly updateCategory: UpdateCategoryUseCase;
  public readonly deleteCategory: DeleteCategoryUseCase;

  constructor(deps: CategoryDependencies) {
    this.listCategories = new ListCategoriesUseCase(deps);
    this.createCategory = new CreateCategoryUseCase(deps);
    this.updateCategory = new UpdateCategoryUseCase(deps);
    this.deleteCategory = new DeleteCategoryUseCase(deps);
  }
}
