/**
 * `GET /customers/:id/orders` — histórico paginado de comandas do cliente.
 *
 * `closed_at DESC NULLS LAST` é explícito de propósito: comanda aberta não tem
 * `closed_at`, e no `DESC` do Postgres os NULLs vêm PRIMEIRO — a comanda em
 * aberto que o cliente tem agora apareceria no topo de um histórico de visitas
 * passadas. Com `NULLS LAST` ela fica no fim, que é onde "ainda não terminou"
 * pertence.
 *
 * Batch em 2 queries de dados (mais a contagem, como em `listOrdersUsecase`):
 * comandas com `tableNumber` por LEFT JOIN e totais/contagem por uma agregação
 * agrupada por comanda. Nada aqui é por comanda — o N+1 do doc 12 não volta.
 */
import { Errors } from "../../../domain/errors.js";
import { round2 } from "../../../domain/money.js";
import { isValidReportDate } from "../../report-overview.usecases.js";
import { dayEnd, dayStart, isValidTz } from "../../cash-flow/day-bounds.js";
import type { CustomerDependencies } from "../ports/customer-dependencies.js";

export type ListCustomerOrdersInput = {
  limit: number;
  offset: number;
  from?: string;
  to?: string;
  tz?: string;
};

export class ListCustomerOrdersUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(customerId: string, input: ListCustomerOrdersInput) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const customer = await session.customers.findById(customerId);
      if (!customer) throw Errors.notFound("Cliente");

      // Filtro de dia é OPCIONAL e é o que faz o drill-down do gráfico funcionar:
      // filtrar no cliente sobre a página 1 de 20 de um dia esconde as comandas
      // mais antigas daquele dia, e o gerente conclui que elas não existiram.
      // Filtro no servidor é o único jeito de a página seguinte continuar completa.
      if (input.from !== undefined || input.to !== undefined) {
        if (!isValidReportDate(input.from) || !isValidReportDate(input.to)) {
          throw Errors.validationFailed("from/to devem ser YYYY-MM-DD");
        }
        if (input.from && input.to && input.from > input.to) {
          throw Errors.validationFailed("`from` não pode ser depois de `to`.");
        }
        if (!isValidTz(input.tz)) throw Errors.validationFailed("tz deve ser um offset como -03:00.");
      }
      // Dia LOCAL da loja, como em todo relatório (às 22h de SP a venda é do dia
      // de hoje, não do dia seguinte em UTC) — as bordas vão RESOLVIDAS ao port.
      // `tz` ausente = UTC (default de `dayStart`/`dayEnd`), como no original.
      const from = input.from ? dayStart(input.from, input.tz) : undefined;
      const to = input.to ? dayEnd(input.to, input.tz) : undefined;

      const page = await session.orders.listHistoryByCustomer(customerId, {
        limit: input.limit,
        offset: input.offset,
        from,
        to,
      });
      const agg = await session.orders.aggregateItemsByOrders(page.data.map((o) => o.id));

      const data = page.data.map((o) => ({
        id: o.id,
        status: o.status,
        openedAt: o.openedAt,
        closedAt: o.closedAt,
        tableNumber: o.tableNumber ?? null,
        tabLabel: o.tabLabel ?? null,
        paymentMethod: o.paymentMethod,
        total: round2((agg.get(o.id)?.total ?? 0) + (o.deliveryFee ?? 0)),
        itemCount: agg.get(o.id)?.itemCount ?? 0,
      }));

      return { data, total: page.total };
    });
  }
}
