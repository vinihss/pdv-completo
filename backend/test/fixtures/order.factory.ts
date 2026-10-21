import { db } from "../../src/infra/db/client.js";
import { orders, orderItems, orderPayments } from "../../src/infra/db/schema.js";
import { createWaiter } from "./user.factory.js";
import { createProduct } from "./product.factory.js";

type InsertOrder = typeof orders.$inferInsert;
type SelectOrder = typeof orders.$inferSelect;

type InsertOrderItem = typeof orderItems.$inferInsert;
type SelectOrderItem = typeof orderItems.$inferSelect;

type InsertOrderPayment = typeof orderPayments.$inferInsert;
type SelectOrderPayment = typeof orderPayments.$inferSelect;

export async function createOrder(overrides: Partial<InsertOrder> = {}): Promise<SelectOrder> {
  const id = overrides.id ?? `ord-${crypto.randomUUID()}`;

  let waiterId = overrides.waiterId;
  if (!waiterId) {
    const defaultWaiter = await createWaiter({ id: `u-waiter-${id.slice(-6)}` });
    waiterId = defaultWaiter.id;
  }

  const order: InsertOrder = {
    id,
    waiterId,
    status: overrides.status ?? "open",
    channel: overrides.channel ?? "balcao",
    tabLabel: overrides.tabLabel ?? (overrides.tableId || overrides.customerId ? undefined : `Comanda ${id.slice(-4)}`),
    tableId: overrides.tableId,
    customerId: overrides.customerId,
    cancelReason: overrides.cancelReason,
    notes: overrides.notes,
    ...overrides,
  };

  await db
    .insert(orders)
    .values(order)
    .onConflictDoUpdate({
      target: [orders.tenantId, orders.id],
      set: order,
    });

  return order as SelectOrder;
}

export async function createOrderItem(
  orderId: string,
  overrides: Partial<InsertOrderItem> = {},
): Promise<SelectOrderItem> {
  const id = overrides.id ?? `item-${crypto.randomUUID()}`;

  let productId = overrides.productId;
  let unitPrice = overrides.unitPrice;

  if (!productId) {
    const prod = await createProduct({ id: `p-auto-${id.slice(-6)}`, price: unitPrice ?? 15.0 });
    productId = prod.id;
    if (unitPrice === undefined) {
      unitPrice = prod.price;
    }
  }

  let createdBy = overrides.createdBy;
  if (!createdBy) {
    const waiter = await createWaiter({ id: `u-waiter-${id.slice(-6)}` });
    createdBy = waiter.id;
  }

  const item: InsertOrderItem = {
    id,
    orderId,
    productId,
    quantity: overrides.quantity ?? 1,
    unitPrice: unitPrice ?? 15.0,
    costPrice: overrides.costPrice ?? 5.0,
    status: overrides.status ?? "ordered",
    version: overrides.version ?? 1,
    createdBy,
    notes: overrides.notes,
    selectedVariations: overrides.selectedVariations ?? "{}",
    ...overrides,
  };

  await db
    .insert(orderItems)
    .values(item)
    .onConflictDoUpdate({
      target: [orderItems.tenantId, orderItems.id],
      set: item,
    });

  return item as SelectOrderItem;
}

export async function createOrderPayment(
  orderId: string,
  overrides: Partial<InsertOrderPayment> = {},
): Promise<SelectOrderPayment> {
  const id = overrides.id ?? `pay-${crypto.randomUUID()}`;

  let createdBy = overrides.createdBy;
  if (!createdBy) {
    const waiter = await createWaiter({ id: `u-waiter-${id.slice(-6)}` });
    createdBy = waiter.id;
  }

  const payment: InsertOrderPayment = {
    id,
    orderId,
    method: overrides.method ?? "cash",
    amount: overrides.amount ?? 10.0,
    received: overrides.received,
    change: overrides.change,
    confirmed: overrides.confirmed ?? true,
    confirmedAt: overrides.confirmedAt,
    confirmedBy: overrides.confirmedBy,
    createdBy,
    ...overrides,
  };

  await db
    .insert(orderPayments)
    .values(payment)
    .onConflictDoUpdate({
      target: [orderPayments.tenantId, orderPayments.id],
      set: payment,
    });

  return payment as SelectOrderPayment;
}
