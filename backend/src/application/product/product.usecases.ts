/**
 * Catálogo — produtos. Ponto de entrada de COMPATIBILIDADE.
 *
 * A implementação foi decomposta em um Use Case por operação (Command
 * Pattern / Single Use Case Class), todos em `usecases/*.usecase.ts`, com as
 * dependências compartilhadas em `ports/product-dependencies.ts`, os helpers
 * de serialização em `shared/product-helpers.ts` e o facade `ProductModule`
 * em `product.module.ts`.
 *
 * Este arquivo mantém a factory `createProductUsecases` com os NOMES LEGADOS
 * (`listProductsUsecase`, `createProductUsecase`, ...) para os consumidores
 * que ainda instanciam via factory (a composition root provisória
 * `infra/composition/default-usecases.ts` e a rota `catalog.routes.ts`). Nada
 * muda na assinatura observada de fora; internamente a factory só orquestra
 * as classes do `ProductModule`. Para uso novo, prefira instanciar
 * `ProductModule` e chamar `.listProducts.execute(...)`.
 *
 * Semântica preservada do módulo original:
 *   - `listProducts`: cache `products:list:*` (TTL 120s), busca
 *     `unaccent ILIKE`, sorts price_asc/price_desc/nome e N+1 evitado;
 *   - create/update: validações de preço/custo/threshold, 404 de
 *     categoria/grupo, estoque inicial → ajuste no ledger (mesma transação),
 *     audit e invalidação de `products:*`;
 *   - setProductActive: `product_activated`/`product_deactivated`;
 *   - fotos: nome = `<id>.<ext>` (o nome enviado nunca vira caminho),
 *     `image_path` guarda só o basename, arquivo antigo removido quando a
 *     extensão muda, audit na mesma transação.
 */
import { ProductModule } from "./product.module.js";
import type { ProductDependencies } from "./ports/product-dependencies.js";
import type { ListProductsUseCase, ListProductsInput } from "./usecases/list-products.usecase.js";
import type {
  CreateProductUseCase,
  CreateProductInput,
} from "./usecases/create-product.usecase.js";
import type { UpdateProductUseCase, UpdateProductInput } from "./usecases/update-product.usecase.js";
import type { SetProductActiveUseCase } from "./usecases/set-product-active.usecase.js";
import type {
  SaveProductImageUseCase,
  SaveProductImageInput,
} from "./usecases/save-product-image.usecase.js";
import type { ClearProductImageUseCase } from "./usecases/clear-product-image.usecase.js";

export { ProductModule };
export type { ProductDependencies };
export {
  ListProductsUseCase,
  type ListProductsInput,
} from "./usecases/list-products.usecase.js";
export {
  CreateProductUseCase,
  type CreateProductInput,
} from "./usecases/create-product.usecase.js";
export {
  UpdateProductUseCase,
  type UpdateProductInput,
} from "./usecases/update-product.usecase.js";
export { SetProductActiveUseCase } from "./usecases/set-product-active.usecase.js";
export {
  SaveProductImageUseCase,
  type SaveProductImageInput,
} from "./usecases/save-product-image.usecase.js";
export { ClearProductImageUseCase } from "./usecases/clear-product-image.usecase.js";

// Re-exportado pra não quebrar os consumidores históricos (menu público,
// cadastro de produto). A implementação é pura e mora em domain/variations.ts.
export { normalizeVariations, type VariationGroup } from "../../domain/variations.js";

/** Nome legado da interface de dependências (o módulo passou a chamá-la `ProductDependencies`). */
export type ProductUsecasesDeps = ProductDependencies;

export interface ProductUsecases {
  listProductsUsecase(input: ListProductsInput): ReturnType<ListProductsUseCase["execute"]>;
  createProductUsecase(
    input: CreateProductInput,
    actorId: string,
  ): ReturnType<CreateProductUseCase["execute"]>;
  updateProductUsecase(
    id: string,
    input: UpdateProductInput,
    actorId: string,
  ): ReturnType<UpdateProductUseCase["execute"]>;
  setProductActiveUsecase(
    id: string,
    active: boolean,
    actorId: string,
  ): ReturnType<SetProductActiveUseCase["execute"]>;
  saveProductImageUsecase(
    id: string,
    input: SaveProductImageInput,
    actorId: string,
  ): ReturnType<SaveProductImageUseCase["execute"]>;
  clearProductImageUsecase(
    id: string,
    actorId: string,
  ): ReturnType<ClearProductImageUseCase["execute"]>;
}

/**
 * Factory de compatibilidade: monta o `ProductModule` e devolve os métodos
 * com os nomes legados, prontos para uso sem `this`.
 */
export function createProductUsecases(deps: ProductUsecasesDeps): ProductUsecases {
  const module = new ProductModule(deps);
  return {
    listProductsUsecase: (input) => module.listProducts.execute(input),
    createProductUsecase: (input, actorId) => module.createProduct.execute(input, actorId),
    updateProductUsecase: (id, input, actorId) => module.updateProduct.execute(id, input, actorId),
    setProductActiveUsecase: (id, active, actorId) =>
      module.setProductActive.execute(id, active, actorId),
    saveProductImageUsecase: (id, input, actorId) =>
      module.saveProductImage.execute(id, input, actorId),
    clearProductImageUsecase: (id, actorId) => module.clearProductImage.execute(id, actorId),
  };
}
