import type { DaemonOrder } from "./printer.client.js";

/**
 * Mapeia uma comanda serializada do PDV para o formato Order do daemon.
 *
 * O daemon espera valores em centavos inteiros e um subconjunto de campos.
 * Esta função é pura — recebe o order + customer + delivery já resolvidos.
 */

export interface PdvOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  selectedVariations: Record<string, string | string[]>;
  notes: string | null;
}

export interface PdvOrder {
  id: string;
  tabLabel: string | null;
  customerName: string | null;
  tableNumber: string | null;
  channel: string;
  deliveryFee: number | null;
  openedAt: string;
  /** Observação do pedido inteiro (checkout público). Ver `DaemonOrder.notes`. */
  notes: string | null;
  items: PdvOrderItem[];
  payments: Array<{ method: string; amount: number; change: number | null }>;
}

export interface PdvCustomer {
  name: string;
  phone: string | null;
}

export interface PdvDelivery {
  address: string;
  notes: string | null;
}

function channelToType(channel: string): string {
  switch (channel) {
    case "balcao":
      return "MESA";
    case "whatsapp":
    case "web":
      return "DELIVERY";
    case "ifood":
      return "IFOOD";
    default:
      return channel.toUpperCase();
  }
}

function variationsToAddons(selected: Record<string, string | string[]>): string[] {
  const addons: string[] = [];
  for (const group of Object.values(selected)) {
    if (Array.isArray(group)) addons.push(...group);
    else addons.push(group);
  }
  return addons;
}

export function toDaemonOrder(
  order: PdvOrder,
  customer: PdvCustomer | null,
  delivery: PdvDelivery | null
): DaemonOrder {
  const items = order.items.map((it) => ({
    name: it.name,
    quantity: it.quantity,
    unit_price_cents: Math.round(it.unitPrice * 100),
    notes: it.notes ?? "",
    addons: variationsToAddons(it.selectedVariations),
  }));

  const itemsTotal = order.items.reduce((acc, it) => acc + it.unitPrice * it.quantity, 0);
  const totalCents = Math.round((itemsTotal + (order.deliveryFee ?? 0)) * 100);

  const number = order.tabLabel ?? order.customerName ?? (order.tableNumber ? `Mesa ${order.tableNumber}` : order.id.slice(0, 8));

  const result: DaemonOrder = {
    number,
    created_at: order.openedAt,
    type: channelToType(order.channel),
    notes: order.notes ?? "",
    items,
    total_cents: totalCents,
  };

  if (customer) {
    result.customer = { name: customer.name, phone: customer.phone ?? "" };
  }

  if (delivery) {
    // O PDV guarda o endereço formatado em delivery.address (snapshot do checkout).
    // O daemon espera campos separados; como o PDV não tem CEP/número/bairro
    // estruturados, enviamos o endereço completo em address e deixamos os
    // demais vazios — o template do daemon pode ajustar se necessário.
    result.delivery = {
      address: delivery.address,
      number: "",
      complement: "",
      neighborhood: "",
      reference: delivery.notes ?? "",
    };
  }

  const cashPayment = order.payments.find((p) => p.method === "cash");
  if (cashPayment) {
    result.payment = {
      method: cashPayment.method,
      change_cents: Math.round((cashPayment.change ?? 0) * 100),
    };
  }

  return result;
}
