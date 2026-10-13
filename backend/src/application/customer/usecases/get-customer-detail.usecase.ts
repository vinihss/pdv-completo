/**
 * `GET /customers/:id` — detalhe com endereços e comandas em aberto.
 *
 * Comandas abertas do cliente: o alerta "este cliente tem uma comanda em
 * aberto" é a informação que o caixa precisa ANTES de cobrar/conferir, e ela
 * não pode depender de uma segunda consulta do frontend.
 *
 * Batch em 2 queries (mesma régua de `listOrdersUsecase`, ver
 * docs/12-n-plus-one-list-orders.md): as comandas vêm com `tableNumber` já
 * por LEFT JOIN e os totais por uma agregação agrupada por comanda. A mais
 * antiga primeiro, que é a que está há mais tempo esperando pagamento.
 */
import { Errors } from "../../../domain/errors.js";
import { round2 } from "../../../domain/money.js";
import type { CustomerDependencies } from "../ports/customer-dependencies.js";
import { serializeCustomer } from "../shared/customer-helpers.js";

export class GetCustomerDetailUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(id: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const customer = await session.customers.findById(id);
      if (!customer) throw Errors.notFound("Cliente");
      const addresses = await session.customerAddresses.listByCustomer(customer.id);
      // Criados primeiro (mesma ordenação do `orderBy createdAt ASC` do
      // original) — ordenado aqui porque `listByCustomer` é compartilhado
      // com o self-service e não ordena.
      addresses.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

      const openRows = await session.orders.listOpenByCustomer(customer.id);
      const openAgg = await session.orders.aggregateItemsByOrders(openRows.map((o) => o.id));

      return {
        ...serializeCustomer(customer),
        addresses: addresses.map((a) => ({
          id: a.id,
          label: a.label ?? null,
          cep: a.cep ?? null,
          street: a.street,
          number: a.number,
          complement: a.complement ?? null,
          neighborhood: a.neighborhood,
          city: a.city,
          // `state` (UF) entrou em 0006 e a rota pública de endereço já devolvia;
          // aqui faltava, e o cadastro manual (rota do gerente) não tinha o campo
          // no schema. Cliente salvo pelo balcão ficava sem UF enquanto o mesmo
          // cliente salvo no checkout tinha.
          state: a.state ?? null,
          reference: a.reference ?? null,
          isDefault: a.isDefault,
        })),
        openOrders: openRows.map((o) => ({
          id: o.id,
          tableNumber: o.tableNumber ?? null,
          tabLabel: o.tabLabel ?? null,
          openedAt: o.openedAt,
          total: round2((openAgg.get(o.id)?.total ?? 0) + (o.deliveryFee ?? 0)),
          status: o.status,
        })),
      };
    });
  }
}
