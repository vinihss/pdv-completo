import { formatBRL } from "@/shared/lib";

export function toMenuFormaReceipt(order, storeName) {
  const items = order.items.map((it) => ({
    name: it.name,
    qty: it.quantity,
    price: it.unitPrice,
  }));

  const itemsTotal = order.items.reduce((acc, it) => acc + it.unitPrice * it.quantity, 0);
  const deliveryFee = order.deliveryFee ?? 0;
  const total = itemsTotal + deliveryFee;

  const payment = order.payments?.[0];
  const paymentMethod = payment
    ? { cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" }[payment.method] ?? payment.method
    : null;

  const typeLabel = { balcao: "MESA", whatsapp: "DELIVERY", web: "DELIVERY", ifood: "IFOOD" }[order.channel] ?? order.channel.toUpperCase();

  const number = order.tabLabel ?? order.customerName ?? (order.tableNumber ? `Mesa ${order.tableNumber}` : order.id.slice(0, 8));

  return {
    storeName: storeName || "Restaurante",
    orderNumber: `#${number}`,
    orderType: typeLabel,
    items,
    subtotal: itemsTotal,
    deliveryFee: deliveryFee > 0 ? deliveryFee : undefined,
    total,
    paymentMethod,
    footer: "Obrigado pela preferência!",
  };
}
