/**
 * Caso de uso: ativar/desativar produto.
 *
 * Exige produto existente (404), aplica o toggle, registra
 * `product_activated`/`product_deactivated` no audit e invalida o cache.
 */
import type { ProductDependencies } from "../ports/product-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { ProductHelpers } from "../shared/product-helpers.js";

export class SetProductActiveUseCase {
  constructor(private readonly deps: ProductDependencies) {}

  async execute(id: string, active: boolean, actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.catalog.findProduct(id);
      if (!existing) throw Errors.notFound("Produto");
      const updated = await session.catalog.setProductActive(id, active);
      await session.audit.record({
        actorId,
        action: active ? "product_activated" : "product_deactivated",
        details: { productId: id, name: updated.name },
      });
      await this.deps.cache.invalidatePrefix("products:");
      return ProductHelpers.serializeWithStock(session, updated);
    });
  }
}
