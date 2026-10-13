/**
 * Serialização do hub de pedidos — linha do banco → payload da API.
 *
 * Reúne os mappers de item/entrega/pagamento e o do detalhe da comanda
 * (`serializeOrder`), compartilhados por lifecycle (open), payment e query
 * (get). Nenhuma regra de negócio: só monta o objeto que o client consome.
 */
import { Errors } from "../../../domain/errors.js";
import type { TenantSession } from "../../ports/unit-of-work.js";
import type {
  DeliveryRecord,
  OrderItemRow,
  OrderItemWithProduct,
  OrderPaymentLineRow,
} from "../../ports/repositories.js";
import type { OrderDependencies } from "../ports/order-dependencies.js";

// Refs do produto no item: nome + foto + grupo de produção. A foto entra no
// próprio item pra tela da cozinha não precisar resolver listProducts inteiro
// (faz o caminho inverso: cozinha consome o que já veio na listagem de órden).
export function serializeItem(
  it: OrderItemRow,
  refs: { name: string; imagePath: string | null; kitchenGroupId: string | null }
) {
  return {
    id: it.id,
    orderId: it.orderId,
    productId: it.productId,
    name: refs.name,
    productImagePath: refs.imagePath,
    kitchenGroupId: refs.kitchenGroupId,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    costPrice: it.costPrice, // snapshot do custo no lançamento (margem)
    selectedVariations: JSON.parse(it.selectedVariations),
    notes: it.notes,
    status: it.status,
    version: it.version,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
  };
}

export function serializeItemWithRefs(it: OrderItemWithProduct) {
  return serializeItem(it, {
    name: it.productName,
    imagePath: it.productImagePath,
    kitchenGroupId: it.productKitchenGroupId,
  });
}

export function serializePayment(p: OrderPaymentLineRow) {
  return {
    id: p.id,
    method: p.method,
    amount: p.amount,
    received: p.received,
    change: p.change,
    confirmed: p.confirmed,
    confirmedAt: p.confirmedAt,
    confirmedBy: p.confirmedBy,
  };
}

// Entrega da comanda (1:1, `delivery.order_id` é UNIQUE). Fica embutida em
// vez de a tela da comanda cruzar com `GET /manager/deliveries` — que é
// restrito ao gerente e não existe pro garçom, que é quem abre a comanda.
export function serializeDelivery(d: DeliveryRecord) {
  return {
    id: d.id,
    status: d.status,
    address: d.address,
    notes: d.notes,
    courierId: d.courierId,
    dispatchedAt: d.dispatchedAt,
    deliveredAt: d.deliveredAt,
  };
}

export async function serializeOrder(session: TenantSession, orderId: string) {
  const order = await session.orders.findRow(orderId);
  if (!order) throw Errors.notFound("Comanda");
  const items = await session.orders.listItemsWithProduct(orderId);

  const table = order.tableId ? await session.catalog.findTable(order.tableId) : null;
  const customer = order.customerId ? await session.customers.findById(order.customerId) : null;
  const payments = await session.orders.listPaymentLines(orderId);
  const delivery = await session.deliveries.findByOrder(orderId);

  return {
    id: order.id,
    status: order.status,
    tableId: order.tableId,
    tableNumber: table?.number ?? null,
    customerId: order.customerId,
    customerName: customer?.name ?? null,
    // O mapper de impressão do daemon (frontend entities/printer) já esperava
    // estes dois campos e nunca os recebia: o cupom do entregador impresso pelo
    // botão do app saía sem telefone e sem endereço. A impressão automática do
    // backend já mandava (printer.usecases.ts).
    customerPhone: customer?.phone ?? null,
    tabLabel: order.tabLabel,
    waiterId: order.waiterId,
    channel: order.channel,
    externalRef: order.externalRef,
    deliveryFee: order.deliveryFee,
    cancelReason: order.cancelReason,
    notes: order.notes ?? null,
    paymentMethod: order.paymentMethod,
    paymentConfirmedAt: order.paymentConfirmedAt,
    paymentConfirmedBy: order.paymentConfirmedBy,
    openedAt: order.openedAt,
    closedAt: order.closedAt,
    delivery: delivery ? serializeDelivery(delivery) : null,
    items: items.map(serializeItemWithRefs),
    payments: payments.map(serializePayment),
  };
}

export async function serializeOrderOutside(deps: OrderDependencies, orderId: string) {
  return deps.uow.run(deps.tenant(), (session) => serializeOrder(session, orderId));
}
