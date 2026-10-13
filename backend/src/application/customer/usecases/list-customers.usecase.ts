/**
 * `GET /customers` — listagem paginada (gerente/caixa).
 *
 * Busca `unaccent ILIKE` + filtro `active` + contagem de endereços em LOTE (o
 * adapter faz `WHERE customer_id IN (...)` — corrige o TODO do original, que
 * agrupava a tabela INTEIRA por página).
 */
import type { CustomerDependencies } from "../ports/customer-dependencies.js";
import { serializeCustomer } from "../shared/customer-helpers.js";

export type ListCustomersInput = {
  search?: string;
  active?: boolean;
  limit: number;
  offset: number;
};

export class ListCustomersUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(input: ListCustomersInput) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const page = await session.customers.list(input);

      // Contagem de endereços em lote (evita N+1 na listagem). O adapter
      // filtra por `customer_id IN (ids da página)` — uma query só, sem
      // varrer a tabela inteira (corrige o TODO do original).
      const counts = await session.customers.countAddressesByCustomer(page.data.map((c) => c.id));

      return {
        data: page.data.map((c) => serializeCustomer(c, counts.get(c.id) ?? 0)),
        total: page.total,
      };
    });
  }
}
