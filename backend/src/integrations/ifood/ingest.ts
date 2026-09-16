import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { customers, deliveries, orders, products } from "../../infra/db/schema.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { openOrderUsecase, addItemsUsecase } from "../../application/order/order.usecases.js";
import type { IfoodOrder, IfoodDeliveryAddress } from "./order.types.js";

const DELIVERY_ROOM = "deliveries"; // mesmo room do painel do manager / listagem do entregador

/**
 * Traduz um pedido da iFood Order API para o fluxo local (mesmo modelo de
 * composição do createSelfServiceOrderUsecase, §04: openOrder + addItems como
 * chamadas em sequência, cada uma com sua própria transação).
 *
 * Pontos de decisão:
 * - O cliente é resolvido por telefone (mesma chave do self-service). O iFood
 *   costuma mascarar o telefone ("119***0000") — o registro é criado com o que
 *   vier; ver docs/06-ifood-integration.md para o ajuste fino na homologação.
 * - Itens casam pelo campo iFood `externalCode` (= nosso product.ifood_sku) ou
 *   pelo id do produto no catálogo iFood. Produto não encontrado => NÃO abre
 *   pedido (erro de mapeamento) — quem chama decide entre cancelar ou pular.
 * - Entrega: se deliveredBy === "MERCHANT" cria o registro local de delivery
 *   (fluxo de entregador/courier); se entregue pelo iFood (padrão), o pedido
 *   não tem courier local e o ciclo é acompanhado por eventos (Etapa C).
 */
export async function ingestIfoodOrder(order: IfoodOrder): Promise<{
  ok: true;
  orderId: string;
  items: any[];
  total: number;
  deliveryFee: number;
  mappedItems: number;
} | { ok: false; reason: "unmapped_items" | "no_items"; details?: unknown }> {
  if (!order.items || order.items.length === 0) {
    return { ok: false, reason: "no_items" };
  }

  // 1. Resolve/cria cliente por telefone (mesma chave do self-service).
  let customer = null;
  const phone = digits(order.customer?.phone);
  if (phone) customer = await db.query.customers.findFirst({ where: eq(customers.phone, phone) });
  if (!customer) {
    const [created] = await db
      .insert(customers)
      .values({ name: order.customer?.name?.trim() || "Cliente iFood", phone: phone || null })
      .returning();
    customer = created;
  }

  // 2. Casa produtos locais com os itens do pedido (externalCode/ifood_sku).
  const mappedItems: Array<{ productId: string; quantity: number; notes?: string }> = [];
  const unknownSkus: string[] = [];
  for (const item of order.items) {
    const product = await findLocalProduct(item.product.id, item.product.externalCode);
    if (!product) {
      unknownSkus.push(`sku=${item.product.externalCode ?? item.product.id} qty=${item.quantity}`);
      continue;
    }
    mappedItems.push({
      productId: product.id,
      quantity: item.quantity,
      notes: buildItemNotes(item),
    });
  }
  if (unknownSkus.length > 0 || mappedItems.length === 0) {
    // Não abre pedido parcial — melhor cancelar no iFood do que confirmar algo
    // que não conseguimos entregar integralmente.
    return { ok: false, reason: "unmapped_items", details: { unknownSkus } };
  }

  // 3. Abre a comanda (channel "ifood", externalRef = orderId do iFood).
  const deliveryFee = order.orderAmount?.deliveryFee ?? 0;
  const orderLocal = await openOrderUsecase({
    waiterId: SYSTEM_USER_ID,
    customerId: customer.id,
    tabLabel: `iFood ${order.displayId ?? order.id}`,
    channel: "ifood",
    deliveryFee,
    externalRef: order.id,
  });

  // 4. Itens — addItemsUsecase já roteia por estação (kitchen-display) e
  //    snapshotta o preço local.
  const items = await addItemsUsecase({ orderId: orderLocal.id, userId: SYSTEM_USER_ID, items: mappedItems });

  // Persiste os métodos de pagamento do iFood (usados no CONCLUDED, Etapa C).
  if (order.payments && order.payments.length > 0) {
    db.update(orders).set({ ifoodPayments: JSON.stringify(order.payments) }).where(eq(orders.id, orderLocal.id)).run();
  }

  // 5. Broadcast + (se for entrega pelo restaurante) registro local de delivery.
  const itemsTotal = items.reduce((sum: number, it: any) => sum + it.unitPrice * it.quantity, 0);
  const total = itemsTotal + deliveryFee;
  const deliveredBy = order.delivery?.deliveredBy ?? "IFOOD";

  db.transaction((tx) => {
    if (deliveredBy === "MERCHANT") {
      const address = formatIfoodAddress(order.delivery?.deliveryAddress);
      tx.insert(deliveries).values({ orderId: orderLocal.id, address, status: "awaiting_courier" }).run();
      enqueueEvent(tx, DELIVERY_ROOM, "delivery.created", { orderId: orderLocal.id, channel: "ifood" });
    }
    enqueueEvent(tx, DELIVERY_ROOM, "ifood.order.created", {
      orderId: orderLocal.id,
      externalRef: order.id,
      displayId: order.displayId ?? order.id,
      itemCount: items.reduce((s: number, i: any) => s + i.quantity, 0),
      total,
    });
    logAction(tx, SYSTEM_USER_ID, "ifood_order_ingested", orderLocal.id, {
      externalRef: order.id,
      displayId: order.displayId ?? null,
      deliveredBy,
      mappedItems: mappedItems.length,
    });
  });

  return {
    ok: true,
    orderId: orderLocal.id,
    items,
    total,
    deliveryFee,
    mappedItems: mappedItems.length,
  };
}

// item.product.externalCode é o nosso ifood_sku (configurado no cadastro, §0004);
// fallback pelo id do produto no catálogo iFood (UUID, se o SKU não tiver sido
// preenchido).
async function findLocalProduct(ifoodProductId: string | undefined, externalCode: string | undefined) {
  if (externalCode) {
    const bySku = await db.query.products.findFirst({ where: eq(products.ifoodSku, externalCode) });
    if (bySku && bySku.ifoodEnabled && bySku.active) return bySku;
  }
  if (ifoodProductId) {
    const byId = await db.query.products.findFirst({ where: eq(products.id, ifoodProductId) });
    if (byId && byId.ifoodEnabled && byId.active) return byId;
  }
  return null;
}

// Observação do item: complements (variações/ingredientes escolhidos no iFood)
// em texto — cai em order_item.notes, a tela da cozinha já exibe.
function buildItemNotes(item: IfoodOrder["items"][number]): string | undefined {
  const complements = Array.isArray(item.complement)
    ? item.complement
        .map((c) => ((c as { name?: string }).name ?? c) as string)
        .filter(Boolean)
        .join(", ")
    : "";
  const notes = [complements, item.notes].filter(Boolean).join(" | ");
  return notes || undefined;
}

// Snapshot de endereço p/ delivery local — mesmo formato (texto) do
// customer_address que a listagem do manager já usa.
function formatIfoodAddress(a?: IfoodDeliveryAddress): string {
  if (!a) return "Endereço não informado";
  if (a.formattedAddress) return a.formattedAddress;
  const parts = [a.streetName, a.streetNumber ? `, ${a.streetNumber}` : "", a.complement ? ` - ${a.complement}` : "", a.neighborhood ? ` · ${a.neighborhood}` : "", a.city ? `, ${a.city}` : ""];
  return parts.join("").trim();
}

function digits(v?: string): string {
  return (v ?? "").replace(/\D/g, "");
}