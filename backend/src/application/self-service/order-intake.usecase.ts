import { eq, and, inArray, desc } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { customers, customerAddresses, deliveries, storeSettings, orders, orderItems } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { openOrderUsecase, addItemsUsecase, getOrderUsecase, registerPaymentUsecase } from "../order/order.usecases.js";
import { formatAddress, addCustomerAddressUsecase } from "./customer-address.usecases.js";
import { deriveCustomerStage, stageTimeline, CUSTOMER_STAGES } from "../../domain/customer-order-state.js";
import { emitCustomerStageChangedTx } from "./customer-stage.js";
import { round2 } from "../../domain/money.js";

const DELIVERY_ROOM = "deliveries"; // painel do manager e listagem do entregador escutam aqui

/**
 * Ponto único de checkout self-service (§04 "Decisões de arquitetura" —
 * "Checkout é uma função compartilhada, não duplicada por canal"). Tanto o
 * webhook do WhatsApp quanto a rota pública da página chamam esta função
 * diretamente, nunca reimplementam a lógica de resolver cliente/endereço
 * ou criar o pedido.
 *
 * Composição de chamadas já existentes (openOrderUsecase/addItemsUsecase),
 * cada uma com sua própria transação — mesmo padrão de composição que o
 * fluxo normal de garçom já usa entre `POST /orders` e `POST /orders/:id/items`
 * como duas chamadas em sequência, não uma transação única.
 */
export async function createSelfServiceOrderUsecase(input: {
  channel: "whatsapp" | "web";
  customerPhone: string;
  customerName: string;
  addressId?: string;
  newAddress?: {
    label?: string;
    street: string;
    number: string;
    complement?: string;
    neighborhood: string;
    city: string;
    reference?: string;
    isDefault?: boolean;
  };
  items: Array<{
    productId: string;
    quantity: number;
    selectedVariations?: Record<string, string | string[]>;
    notes?: string;
  }>;
  paymentMethodIntent: "cash" | "card" | "pix" | "other";
}) {
  if (!input.addressId && !input.newAddress) {
    throw Errors.validationFailed({ field: "addressId|newAddress", reason: "informe um endereço" });
  }

  // 1. Resolve ou cria o cliente pelo telefone (chave de identificação nos dois canais).
  let customer = await db.query.customers.findFirst({ where: eq(customers.phone, input.customerPhone) });
  if (!customer) {
    const [created] = await db
      .insert(customers)
      .values({ name: input.customerName, phone: input.customerPhone })
      .returning();
    customer = created;
  }

  // 2. Resolve o endereço — salvo existente ou novo (aplica o limite de 3 via usecase dedicado).
  let addressText: string;
  if (input.addressId) {
    const address = await db.query.customerAddresses.findFirst({ where: eq(customerAddresses.id, input.addressId) });
    if (!address || address.customerId !== customer.id) throw Errors.notFound("Endereço");
    addressText = formatAddress(address);
  } else {
    const created = await addCustomerAddressUsecase({ customerId: customer.id, ...input.newAddress! });
    addressText = formatAddress(created);
  }

  // 3. Taxa de entrega — snapshot da configuração atual, gravado no pedido (§04 "Taxa de entrega").
  const settings = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (!settings) throw new Error("store_settings não inicializado — rode o seed.");

  // 4. Cria o pedido reaproveitando as mesmas usecases do garçom — só muda quem abre (SYSTEM_USER_ID) e o channel.
  const order = await openOrderUsecase({
    waiterId: SYSTEM_USER_ID,
    customerId: customer.id,
    tabLabel: `Delivery - ${input.customerName}`,
    channel: input.channel,
    deliveryFee: settings.deliveryFee,
  });

  const items = await addItemsUsecase({ orderId: order.id, userId: SYSTEM_USER_ID, items: input.items });

  // Sem isso, closeOrderUsecase rejeitaria o fechamento por
  // "payment_not_registered" quando a entrega for confirmada (ver
  // deliverDeliveryUsecase). confirmed:false porque é só a intenção
  // declarada no checkout — a confirmação de verdade acontece quando o
  // entregador recebe o pagamento, na entrega. Respeita
  // store_settings.enabledPaymentMethods (mesma validação que o balcão já
  // usa) — se o gerente desabilitou "pix", por exemplo, o checkout falha
  // aqui com o erro correto em vez de criar um pedido que não vai fechar.
  await registerPaymentUsecase({
    orderId: order.id,
    userId: SYSTEM_USER_ID,
    paymentMethod: input.paymentMethodIntent,
    confirmed: false,
  });

  // 5. Cria a entrega já no momento do pedido — não é preciso esperar a cozinha
  // pra o manager já poder planejar/atribuir entregador (correção sobre o
  // desenho original do §04, que sugeria criar isso só quando os itens
  // ficassem "ready"; o endereço já está resolvido aqui, então não há motivo
  // pra adiar, e adiar exigiria guardar o endereço em algum lugar intermediário).
  const delivery = db.transaction((tx) => {
    const created = tx
      .insert(deliveries)
      .values({ orderId: order.id, address: addressText, status: "awaiting_courier" })
      .returning()
      .get();

    enqueueEvent(tx, DELIVERY_ROOM, "delivery.created", { deliveryId: created.id, orderId: order.id });
    // Stage inicial "received" — o WS público (retomada por ?order=<id>)
    // e o polling do cliente partem do estado canônico da máquina.
    emitCustomerStageChangedTx(tx, order.id);
    logAction(tx, SYSTEM_USER_ID, "delivery_created", order.id, { channel: input.channel, addressText });

    return created;
  });

  const itemsTotal = items.reduce((sum: number, it: any) => sum + it.unitPrice * it.quantity, 0);
  const total = itemsTotal + (settings.deliveryFee ?? 0);

  return {
    orderId: order.id,
    deliveryId: delivery.id,
    total,
    deliveryFee: settings.deliveryFee,
    // Estimativa fixa por enquanto — sem modelo de tempo de preparo por pedido delivery ainda.
    estimatedMinutes: 45,
  };
}

/**
 * Status público do pedido pra o cliente — inclui o estado canônico da
 * máquina (customer-order-state.ts) além dos eixos brutos (mantidos pra
 * compat do polling). total/estimatedMinutes alimentam a retomada por
 * ?order=<id> (o orderId é a "senha" de fato — já era visível hoje).
 */
export async function getSelfServiceOrderStatusUsecase(orderId: string) {
  const order = await getOrderUsecase(orderId);
  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.orderId, orderId) });

  const stage = deriveCustomerStage(
    { status: order.status },
    order.items.map((i: any) => ({ status: i.status })),
    delivery ? { status: delivery.status } : null
  );
  const meta = CUSTOMER_STAGES[stage];
  const total = round2(
    order.items
      .filter((i: any) => i.status !== "cancelled")
      .reduce((sum: number, i: any) => sum + i.unitPrice * i.quantity, 0) + (order.deliveryFee ?? 0)
  );

  return {
    orderStatus: order.status,
    itemsStatus: order.items.map((i: any) => ({ id: i.id, status: i.status })),
    deliveryStatus: delivery?.status ?? null,
    customerStage: { stage, label: meta.label, terminal: meta.terminal },
    timeline: stageTimeline(stage),
    total,
    // Mesma estimativa da criação — sem modelo de tempo de preparo ainda.
    estimatedMinutes: 45,
  };
}

/**
 * Pedido em andamento pra retomada — cliente que fechou o browser ou
 * voltou depois vê "Você tem um pedido em andamento" (página e WhatsApp).
 * Andamento = orders.status "open" (não fechado/cancelado) do canal
 * self-service; o stage pode ser terminal-fracassado ("failed") — o
 * cliente precisa ver isso também pra poder cancelar ou reordenar.
 */
export async function getActiveSelfServiceOrderByPhoneUsecase(phone: string) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.phone, phone) });
  if (!customer) return null;

  const active = await db.query.orders.findFirst({
    where: and(eq(orders.customerId, customer.id), inArray(orders.channel, ["whatsapp", "web"]), eq(orders.status, "open")),
    orderBy: desc(orders.openedAt),
  });
  if (!active) return null;

  const items = await db.query.orderItems.findMany({ where: eq(orderItems.orderId, active.id) });
  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.orderId, active.id) });

  const stage = deriveCustomerStage(
    { status: active.status },
    items.map((i) => ({ status: i.status })),
    delivery ? { status: delivery.status } : null
  );
  const meta = CUSTOMER_STAGES[stage];
  const total = round2(
    items
      .filter((i) => i.status !== "cancelled")
      .reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) + (active.deliveryFee ?? 0)
  );

  return {
    orderId: active.id,
    customerStage: { stage, label: meta.label, terminal: meta.terminal },
    total,
    estimatedMinutes: 45,
    openedAt: active.openedAt,
  };
}
