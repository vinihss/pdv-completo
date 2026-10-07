// Impressão térmica via daemon local — portado de
// frontend/src/entities/printer/{api/printer.js,lib/daemonOrder.js}.
//
// O daemon roda numa máquina da LAN (configurado como `pdv:daemon` no
// aparelho) e o app fala DIRETO com ele (`fetch` nativo, http em IP privado é
// cleartext ok). O pedido NÃO passa pelo backend: quem monta o cupom é a
// tela, com o mesmo total que o operador vê (`orderTotal`).
//
// Só existe o botão de imprimir quando `isDaemonConfigured()` é true — sem
// daemon o app nem oferece a ação.

import { orderTotal } from "@/entities/order";
import { getDaemonBase } from "@/shared/lib/server";

const TIMEOUT_MS = 8000;

export class PrinterUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "PrinterUnavailableError";
    this.cause = cause;
  }
}

async function daemonFetch(path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${getDaemonBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new PrinterUnavailableError(
      "Não foi possível falar com a impressora. Verifique se o serviço de impressão está rodando e se o endereço configurado está certo.",
      err
    );
  } finally {
    clearTimeout(timer);
  }
}

async function daemonRequest(path, init) {
  const res = await daemonFetch(path, init);
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw new Error(body?.message || `Falha na impressão (HTTP ${res.status}).`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Payload do daemon (espelha o toDaemonOrder do backend printer.mapper.ts)
// ---------------------------------------------------------------------------

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
    notes: order.notes ?? "",
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

export function toPrintRequest(order, destination) {
  return {
    job_id: `${order.id}-${destination}`,
    order_id: order.id,
    destination,
    order: toDaemonOrder(order),
  };
}

// ---------------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------------

export async function printOrder(order, destination) {
  return daemonRequest("/api/print", {
    method: "POST",
    body: JSON.stringify(toPrintRequest(order, destination)),
  });
}