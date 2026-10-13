/**
 * Caso de uso: gravar a foto do produto.
 *
 * O `storage` (port FileStorage) é quem grava/apaga o arquivo; aqui fica só o
 * que é regra de produto: o nome vem do id (o "minha-foto.png" enviado no
 * multipart nunca vira caminho), o `image_path` guarda SÓ o basename e o
 * audit vai na mesma transação do UPDATE.
 */
import type { ProductDependencies } from "../ports/product-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { ProductHelpers } from "../shared/product-helpers.js";

export type SaveProductImageInput = { buffer: Buffer; ext: string };

export class SaveProductImageUseCase {
  constructor(private readonly deps: ProductDependencies) {}

  async execute(id: string, input: SaveProductImageInput, actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.catalog.findProduct(id);
      if (!existing) throw Errors.notFound("Produto");

      const filename = `${id}.${input.ext}`;
      if (!ProductHelpers.isSafeFilename(filename)) throw Errors.validationFailed({ field: "image" });
      await this.deps.storage.put("product", filename, input.buffer);

      // Remove a foto antiga quando o produto trocou a extensão do arquivo
      const previous = ProductHelpers.storageFilename(existing.imagePath);
      if (previous && previous !== filename) await this.deps.storage.remove("product", previous);

      const updated = await session.catalog.saveProductImage(id, filename);
      await session.audit.record({
        actorId,
        action: "product_image_changed",
        details: { productId: id },
      });
      await this.deps.cache.invalidatePrefix("products:");
      return ProductHelpers.serializeWithStock(session, updated);
    });
  }
}
