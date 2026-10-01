import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { Errors } from "../../domain/errors.js";
import {
  orders,
  orderItems,
  orderPayments,
  products,
  customers,
  deliveries,
  restaurantTables,
} from "../../infra/db/schema.js";
import { printerClient, type DaemonJob, type DaemonPrinterStatus } from "./printer.client.js";
import { toDaemonOrder, type PdvOrder, type PdvCustomer, type PdvDelivery } from "./printer.mapper.js";

/**
 * Impressão térmica — integração com o daemon local (printer/).
 *
 * Padrão fire-and-forget (igual whatsapp.notifier): as funções de impressão
 * são chamadas pós-commit das usecases de domínio, com .catch() para nunca
 * quebrar o fluxo principal. O daemon tem sua própria fila de retry.
 */

interface PdvOrderRow {
  id: string;
  tabLabel: string | null;
  customerId: string | null;
  tableNumber: string | null;
  channel: string;
  deliveryFee: number | null;
  openedAt: string;
  notes: string | null;
}

async function fetchOrderData(orderId: string): Promise<PdvOrderRow | null> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) return null;

  const table = order.tableId
    ? await db.query.restaurantTables.findFirst({ where: eq(restaurantTables.id, order.tableId) })
    : null;

  return {
    id: order.id,
    tabLabel: order.tabLabel,
    customerId: order.customerId,
    tableNumber: table?.number ?? null,
    channel: order.channel,
    deliveryFee: order.deliveryFee,
    openedAt: order.openedAt,
    notes: order.notes,
  };
}

async function fetchOrderItems(orderId: string): Promise<PdvOrder["items"]> {
  const items = await db
    .select({
      name: products.name,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
      selectedVariations: orderItems.selectedVariations,
      notes: orderItems.notes,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(eq(orderItems.orderId, orderId));

  return items.map((it) => ({
    name: it.name,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    selectedVariations: JSON.parse(it.selectedVariations),
    notes: it.notes,
  }));
}

async function fetchOrderPayments(orderId: string): Promise<PdvOrder["payments"]> {
  const payments = await db.query.orderPayments.findMany({ where: eq(orderPayments.orderId, orderId) });
  return payments.map((p) => ({ method: p.method, amount: p.amount, change: p.change }));
}

async function fetchCustomer(customerId: string | null): Promise<PdvCustomer | null> {
  if (!customerId) return null;
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  return customer ? { name: customer.name, phone: customer.phone } : null;
}

async function fetchDelivery(orderId: string): Promise<PdvDelivery | null> {
  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.orderId, orderId) });
  return delivery ? { address: delivery.address, notes: delivery.notes } : null;
}

async function sendToDaemon(orderId: string, destination: string): Promise<void> {
  const [orderData, items, payments] = await Promise.all([
    fetchOrderData(orderId),
    fetchOrderItems(orderId),
    fetchOrderPayments(orderId),
  ]);
  if (!orderData) return;

  const customer = await fetchCustomer(orderData.customerId);
  const delivery = destination === "courier" ? await fetchDelivery(orderId) : null;

  const daemonOrder = toDaemonOrder(
    {
      ...orderData,
      customerName: customer?.name ?? null,
      items,
      payments,
    },
    customer,
    delivery
  );

  await printerClient.enqueuePrint({
    job_id: `${orderId}-${destination}`,
    order_id: orderId,
    destination,
    order: daemonOrder,
  });
}

// ---------- API pública (fire-and-forget a partir das usecases) ----------

export async function printKitchenOrder(orderId: string): Promise<void> {
  await sendToDaemon(orderId, "kitchen");
}

export async function printCourierOrder(orderId: string): Promise<void> {
  await sendToDaemon(orderId, "courier");
}

// ---------- API pública (chamadas síncronas das rotas) ----------

export async function reprintOrder(
  orderId: string,
  destination: string
): Promise<{ job_id: string; status: string } | null> {
  const [orderData, items, payments] = await Promise.all([
    fetchOrderData(orderId),
    fetchOrderItems(orderId),
    fetchOrderPayments(orderId),
  ]);
  if (!orderData) return null;

  const customer = await fetchCustomer(orderData.customerId);
  const delivery = destination === "courier" ? await fetchDelivery(orderId) : null;

  const daemonOrder = toDaemonOrder(
    {
      ...orderData,
      customerName: customer?.name ?? null,
      items,
      payments,
    },
    customer,
    delivery
  );

  const job = await printerClient.enqueuePrint({
    job_id: `${orderId}-${destination}`,
    order_id: orderId,
    destination,
    order: daemonOrder,
  });
  // null = daemon fora do ar/erro — não é comanda inexistente (404).
  if (!job) throw Errors.serviceUnavailable("Impressora indisponível. Tente novamente.");
  return job;
}

export async function getPrintJobsForOrder(orderId: string): Promise<DaemonJob[]> {
  const all = await printerClient.getJobs();
  return all.filter((j) => j.order_id === orderId);
}

export async function getPrinterStatus(destination: string): Promise<DaemonPrinterStatus | null> {
  return printerClient.getPrinterStatus(destination);
}
