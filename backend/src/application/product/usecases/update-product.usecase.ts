/**
 * Caso de uso: atualizar produto (parcial).
 *
 * Valida preço/custo/threshold, exige produto existente (404), confere
 * categoria/grupo informados, grava o UPDATE, registra audit e invalida o
 * cache `products:*`. `variations` só é reescrito quando vem no input.
 */
import type { ProductDependencies } from "../ports/product-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { ProductHelpers } from "../shared/product-helpers.js";

export type UpdateProductInput = {
  categoryId?: string | null;
  kitchenGroupId?: string | null;
  name?: string;
  description?: string;
  price?: number;
  variations?: unknown[];
  featured?: boolean;
  active?: boolean;
  costPrice?: number;
  lowStockThreshold?: number;
  trackStock?: boolean;
  unit?: string;
};

export class UpdateProductUseCase {
  constructor(private readonly deps: ProductDependencies) {}

  async execute(id: string, input: UpdateProductInput, actorId: string) {
    this.validate(input);

    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.catalog.findProduct(id);
      if (!existing) throw Errors.notFound("Produto");
      if (input.categoryId) {
        const cat = await session.catalog.findCategoryById(input.categoryId);
        if (!cat) throw Errors.validationFailed({ field: "categoryId" });
      }
      if (input.kitchenGroupId) {
        const grp = await session.catalog.findKitchenGroupById(input.kitchenGroupId);
        if (!grp) throw Errors.validationFailed({ field: "kitchenGroupId" });
      }

      const updated = await session.catalog.saveProduct({
        id,
        categoryId: input.categoryId,
        kitchenGroupId: input.kitchenGroupId,
        name: input.name,
        description: input.description,
        price: input.price,
        variations: input.variations === undefined ? undefined : JSON.stringify(input.variations ?? []),
        featured: input.featured,
        costPrice: input.costPrice,
        lowStockThreshold: input.lowStockThreshold,
        trackStock: input.trackStock,
        unit: input.unit,
        active: input.active,
      });
      await session.audit.record({
        actorId,
        action: "product_updated",
        details: { productId: id, name: updated.name },
      });

      await this.deps.cache.invalidatePrefix("products:");
      return ProductHelpers.serializeWithStock(session, updated);
    });
  }

  private validate(input: UpdateProductInput): void {
    if (input.price !== undefined && input.price < 0)
      throw Errors.validationFailed({ field: "price" });
    if (input.costPrice !== undefined && input.costPrice < 0)
      throw Errors.validationFailed({ field: "costPrice" });
    if (input.lowStockThreshold !== undefined && input.lowStockThreshold < 0)
      throw Errors.validationFailed({ field: "lowStockThreshold" });
  }
}
