import { orderTotal } from "@/entities/order";

/**
 * Monta o payload que o daemon de impressão espera (POST /api/print).
 *
 * Espelha o `toDaemonOrder` do backend (printer.mapper.ts) para que o cupom
 * impresso manualmente pelo navegador saia igual ao que sairia pelo backend.
 *
 * A diferença deliberada: o total usa `orderTotal()`, que **ignora itens
 * cancelados** — o mesmo total que o garçom vê na tela. O mapper do backend
 * soma todos os itens; para o backend isso é seguro porque ele lê o estado
 * persistido, mas no navegador a lista exibida já é a verdade mostrada ao
 * operador e é ela que precisa bater com o papel.
 *
 * Funções puras — testadas sem DOM.
 */

function channelToType(channel) {
  switch (channel) {
    case "balcao":
      return "MESA";
    case "whatsapp":
    case "web":
      return "DELIVERY";
    case "ifood":
      return "IFOOD";
    default:
      return String(channel ?? "").toUpperCase();
  }
}

function variationsToAddons(selected) {
  if (!selected || typeof selected !== "object") return [];
  const addons = [];
  for (const group of Object.values(selected)) {
    if (Array.isArray(group)) addons.push(...group.filter((v) => v != null && v !== ""));
    else if (group != null && group !== "") addons.push(group);
  }
  return addons;
}

/**
 * O PDV guarda o endereço já formatado e sem CEP/número/bairro estruturados,
 * então o campo `address` leva a linha completa e os demais ficam vazios —
 * o mesmo que o backend faz (ver comentário em printer.mapper.ts).
 */
function toDeliveryBlock(delivery) {
  if (!delivery?.address) return null;
  return {
    address: delivery.address,
    number: "",
    complement: "",
    neighborhood: "",
    reference: delivery.notes ?? "",
  };
}

function toPaymentBlock(payments) {
  const cash = (payments ?? []).find((p) => p.method === "cash");
  if (!cash) return null;
  return { method: cash.method, change_cents: Math.round((cash.change ?? 0) * 100) };
}

function toNumber(order) {
  if (order.tabLabel) return order.tabLabel;
  if (order.customerName) return order.customerName;
  if (order.tableNumber) return `Mesa ${order.tableNumber}`;
  return String(order.id ?? "").slice(0, 8);
}

export function toDaemonOrder(order) {
  const items = (order.items ?? []).map((it) => ({
    name: it.name,
    quantity: it.quantity,
    unit_price_cents: Math.round((it.unitPrice ?? 0) * 100),
    notes: it.notes ?? "",
    addons: variationsToAddons(it.selectedVariations),
  }));

  const result = {
    number: toNumber(order),
    created_at: order.openedAt,
    type: channelToType(order.channel),
    notes: "",
    items,
    total_cents: Math.round(orderTotal(order) * 100),
  };

  if (order.customerName) {
    result.customer = { name: order.customerName, phone: order.customerPhone ?? "" };
  }

  const delivery = toDeliveryBlock(order.delivery);
  if (delivery) result.delivery = delivery;

  const payment = toPaymentBlock(order.payments);
  if (payment) result.payment = payment;

  return result;
}

/**
 * Envelope completo do `POST /api/print`.
 *
 * O `job_id` segue `${orderId}-${destination}`: o daemon tem
 * `UNIQUE(order_id, destination)` com `ON CONFLICT ... DO UPDATE`, então
 * reimprimir a mesma comanda re-enfileira em vez de falhar — e trocar a
 * chave (por exemplo, com `Date.now()`) criaria jobs duplicados.
 */
export function toPrintRequest(order, destination) {
  return {
    job_id: `${order.id}-${destination}`,
    order_id: order.id,
    destination,
    order: toDaemonOrder(order),
  };
}
