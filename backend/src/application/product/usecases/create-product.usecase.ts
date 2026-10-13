/**
 * Caso de uso: criar produto.
 *
 * Valida preço/custo/threshold, confere categoria/grupo informados, grava o
 * produto, converte o estoque inicial em ajuste no ledger (MESMA transação),
 * registra audit e invalida o cache `products:*`.
 */
import type { ProductDependencies } from "../ports/product-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { ProductHelpers } from "../shared/product-helpers.js";

export type CreateProductInput = {
  categoryId: string;
  kitchenGroupId?: string | null;
  name: string;
  description?: string;
  price: number;
  variations?: unknown[];
  featured?: boolean;
  active?: boolean;
  costPrice?: number;
  lowStockThreshold?: number;
  trackStock?: boolean;
  unit?: string;
  initialStock?: number;
};

export class CreateProductUseCase {
  constructor(private readonly deps: ProductDependencies) {}

  async execute(input: CreateProductInput, actorId: string) {
    this.validate(input);

    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      if (input.categoryId) {
        const cat = await session.catalog.findCategoryById(input.categoryId);
        if (!cat) throw Errors.validationFailed({ field: "categoryId" });
      }
      if (input.kitchenGroupId) {
        const grp = await session.catalog.findKitchenGroupById(input.kitchenGroupId);
        if (!grp) throw Errors.validationFailed({ field: "kitchenGroupId" });
      }

      const created = await session.catalog.saveProduct({
        categoryId: input.categoryId,
        kitchenGroupId: input.kitchenGroupId,
        name: input.name,
        description: input.description,
        price: input.price,
        variations: JSON.stringify(input.variations ?? []),
        featured: input.featured,
        costPrice: input.costPrice,
        lowStockThreshold: input.lowStockThreshold,
        trackStock: input.trackStock,
        unit: input.unit,
        active: input.active,
      });

      // Estoque inicial informado no cadastro vira um ajuste no ledger
      // (mesma transação — regra: escrita de domínio + audit juntos).
      // Com unit_cost = cost_price manual, vira o primeiro evento de
      // valoração da média móvel quando as compras forem habilitadas.
      if (input.trackStock && input.initialStock !== undefined && input.initialStock !== 0) {
        await session.stock.recordMovement({
          productId: created.id,
          quantityDelta: input.initialStock,
          type: "adjustment",
          unitCost: input.costPrice ?? 0,
          note: "Estoque inicial",
          actorId,
        });
      }
      await session.audit.record({
        actorId,
        action: "product_created",
        details: { productId: created.id, name: created.name },
      });

      await this.deps.cache.invalidatePrefix("products:");
      return ProductHelpers.serializeWithStock(session, created);
    });
  }

  private validate(input: CreateProductInput): void {
    if (input.price < 0) throw Errors.validationFailed({ field: "price" });
    if (input.costPrice !== undefined && input.costPrice < 0)
      throw Errors.validationFailed({ field: "costPrice" });
    if (input.lowStockThreshold !== undefined && input.lowStockThreshold < 0)
      throw Errors.validationFailed({ field: "lowStockThreshold" });
  }
}
