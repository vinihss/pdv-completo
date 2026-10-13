/**
 * GET /orders/:id — detalhe da comanda.
 *
 * O tenant é resolvido na chamada e a leitura serializada roda no mesmo
 * caminho do resto do hub (`serializeOrderOutside`).
 */
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { serializeOrderOutside } from "../shared/order-serializer.js";

export class GetOrderUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(orderId: string) {
    return serializeOrderOutside(this.deps, orderId);
  }
}
