/**
 * Módulo de produtos — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências
 * (injetado via construtor) e expõe as instâncias como propriedades
 * readonly. É o que o composition root (ou um framework de DI) instancia.
 */
import type { ProductDependencies } from "./ports/product-dependencies.js";
import { ListProductsUseCase } from "./usecases/list-products.usecase.js";
import { CreateProductUseCase } from "./usecases/create-product.usecase.js";
import { UpdateProductUseCase } from "./usecases/update-product.usecase.js";
import { SetProductActiveUseCase } from "./usecases/set-product-active.usecase.js";
import { SaveProductImageUseCase } from "./usecases/save-product-image.usecase.js";
import { ClearProductImageUseCase } from "./usecases/clear-product-image.usecase.js";

export class ProductModule {
  public readonly listProducts: ListProductsUseCase;
  public readonly createProduct: CreateProductUseCase;
  public readonly updateProduct: UpdateProductUseCase;
  public readonly setProductActive: SetProductActiveUseCase;
  public readonly saveProductImage: SaveProductImageUseCase;
  public readonly clearProductImage: ClearProductImageUseCase;

  constructor(deps: ProductDependencies) {
    this.listProducts = new ListProductsUseCase(deps);
    this.createProduct = new CreateProductUseCase(deps);
    this.updateProduct = new UpdateProductUseCase(deps);
    this.setProductActive = new SetProductActiveUseCase(deps);
    this.saveProductImage = new SaveProductImageUseCase(deps);
    this.clearProductImage = new ClearProductImageUseCase(deps);
  }
}
