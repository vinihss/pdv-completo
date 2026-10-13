/**
 * GET /tables — mesas para a abertura de comanda.
 */
import type { OrderDependencies } from "../ports/order-dependencies.js";

export class ListTablesUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute() {
    return this.deps.uow.run(this.deps.tenant(), (session) => session.catalog.listTables());
  }
}
