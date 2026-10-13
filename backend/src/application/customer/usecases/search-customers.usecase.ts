/**
 * `GET /customers/search` — busca leve do garçom (abrir comanda com cliente):
 * só ativos, sem email. A manutenção completa é a rota paginada, restrita a
 * gerente/caixa.
 */
import type { CustomerDependencies } from "../ports/customer-dependencies.js";

export class SearchCustomersUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(search?: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const rows = await session.customers.searchLight(search);
      return rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null }));
    });
  }
}
