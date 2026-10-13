/**
 * Caso de uso: remover a foto do produto.
 *
 * Exige produto existente (404), apaga o arquivo pelo port `FileStorage`,
 * limpa o `image_path`, registra audit na mesma transação e invalida o cache.
 */
import type { ProductDependencies } from "../ports/product-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { ProductHelpers } from "../shared/product-helpers.js";

export class ClearProductImageUseCase {
  constructor(private readonly deps: ProductDependencies) {}

  async execute(id: string, actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.catalog.findProduct(id);
      if (!existing) throw Errors.notFound("Produto");
      const previous = ProductHelpers.storageFilename(existing.imagePath);
      if (previous) await this.deps.storage.remove("product", previous);

      const updated = await session.catalog.clearProductImage(id);
      await session.audit.record({
        actorId,
        action: "product_image_removed",
        details: { productId: id },
      });
      await this.deps.cache.invalidatePrefix("products:");
      return ProductHelpers.serializeWithStock(session, updated);
    });
  }
}
