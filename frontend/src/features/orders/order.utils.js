import { formatDateTime, variationsText } from "@/shared/lib";

export { formatDateTime, variationsText };

export function money(v) {
  return `R$ ${Number(v).toFixed(2)}`;
}

export function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

export function orderLabel(order) {
  if (order.tableId && order.tableNumber) return `Mesa ${order.tableNumber}`;
  if (order.tableId) return "Mesa";
  return order.customerName ?? order.tabLabel ?? "—";
}

export function orderTotal(order) {
  const itemsTotal = order.items.reduce(
    (sum, it) => sum + (it.status === "cancelled" ? 0 : it.unitPrice * it.quantity),
    0
  );
  return round2(itemsTotal + (order.deliveryFee ?? 0));
}

export function orderHasReady(order) {
  return order.items.some((i) => i.status === "ready");
}

export function orderAllDelivered(order) {
  return order.items.length > 0 && order.items.every((i) => i.status === "delivered");
}

export function pendingItems(order) {
  return order.items.filter((i) => i.status !== "delivered" && i.status !== "cancelled");
}