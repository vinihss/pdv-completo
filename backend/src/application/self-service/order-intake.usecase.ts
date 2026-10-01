import { eq, and, inArray, desc } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { customers, customerAddresses, deliveries, storeSettings, orders, orderItems, products } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { openOrderUsecase, addItemsUsecase, getOrderUsecase, registerPaymentUsecase } from "../order/order.usecases.js";
import { formatAddress, addCustomerAddressUsecase } from "./customer-address.usecases.js";
import { deriveCustomerStage, stageTimeline, CUSTOMER_STAGES } from "../../domain/customer-order-state.js";
import { emitCustomerStageChangedTx } from "./customer-stage.js";
import { round2 } from "../../domain/money.js";
import { estimateDeliveryMinutes, estimateWindow } from "../../domain/delivery-eta.js";
import { parseTiers, type DeliveryFeeTier } from "../delivery/delivery-pricing.usecase.js";
import { parseVariations, missingRequiredGroups, unknownOptions } from "../../domain/variations.js";

const DELIVERY_ROOM = "deliveries"; // painel do manager e listagem do entregador escutam aqui

/**
 * Valida a faixa escolhida contra a tabela real da loja.
 *
 * O cliente manda `maxKm` como número solto no corpo do pedido, então o valor
 * é dado do cliente até que a tabela diga o contrário. Aceitar qualquer número
 * deixaria a viagem estimada sem teto (minutos_per_km × 999999) ou, no outro
 * extremo, sem piso — e a estimativa é o que o salão promete. unknown → null,
 * que o cálculo trata como "só o piso de viagem".
 */
function resolveZoneKm(requested: number | null | undefined, tiers: DeliveryFeeTier[]): number | null {
  if (requested === null || requested === undefined || !Number.isFinite(requested)) return null;
  const match = tiers.find((t) => t.maxKm === requested);
  return match ? match.maxKm : null;
}

type IntakeLine = {
  productId: string;
  quantity: number;
  selectedVariations?: Record<string, string | string[]>;
  notes?: string;
};

// Confere cada linha contra os grupos de variação do produto. Produto
// inexistente fica pra `addItemsUsecase` responder com o erro dele (404) — aqui
// só filtramos o que dá pra validar.
async function assertVariationsSelectable(lines: IntakeLine[]) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  if (ids.length === 0) return;
  const rows = await db.query.products.findMany({ where: inArray(products.id, ids) });
  const byId = new Map(rows.map((p: any) => [p.id, p]));

  for (const line of lines) {
    const product = byId.get(line.productId) as any;
    if (!product) continue;
    const groups = parseVariations(product.variations);

    const missing = missingRequiredGroups(groups, line.selectedVariations);
    if (missing.length > 0) throw Errors.variationRequired(product.name, missing);

    const unknown = unknownOptions(groups, line.selectedVariations);
    if (unknown.length > 0) {
      throw Errors.variationInvalid(product.name, unknown[0].group, unknown[0].option);
    }
  }
}

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
    cep?: string;
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
  notes?: string;
  /**
   * `maxKm` da faixa de distância que o cliente marcou na tela de endereço.
   * Entra só na estimativa (ver domain/delivery-eta.ts) — o FRETE continua
   * vindo de `store_settings.delivery_fee` aqui, como no §04; trocar a taxa por
   * faixa no checkout é outra conversa e mexeria no total que o cliente
   * confirma. Ausente ou fora das faixas: o tempo de viagem usa só o piso.
   */
  deliveryZoneKm?: number | null;
}) {
  if (!input.addressId && !input.newAddress) {
    throw Errors.validationFailed({ field: "addressId|newAddress", reason: "informe um endereço" });
  }

  // 0. Variações — valida ANTES de qualquer escrita. `addItemsUsecase` grava
  // `selectedVariations` como veio, sem conferir contra o catálogo: sem esta
  // guarda, um X-Burger sem "Ponto da carne" (grupo obrigatório) viraria
  // pedido e a cozinha receberia algo impossível de produzir. Erro 422 com o
  // grupo faltante, pra tela conseguir apontar o que resolver.
  await assertVariationsSelectable(input.items);

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
    notes: input.notes,
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

  // 4.1 Previsão de entrega — calculada ANTES da transação da entrega porque
  // `distance_km` e `estimated_minutes` são gravados no insert (domain/delivery-eta.ts).
  // O que o cliente escolheu na tela é validado contra as faixas reais da loja:
  // um `maxKm` forjado pelo cliente cortaria a viagem estimada pela metade e o
  // balcão receberia uma promessa que não pode cumprir.
  const tiers = parseTiers(settings.deliveryFeeTiers);
  const zoneKm = resolveZoneKm(input.deliveryZoneKm, tiers);
  const estimatedMinutes = estimateDeliveryMinutes({
    maxKm: zoneKm,
    prepMinutes: settings.deliveryPrepMinutes,
    minutesPerKm: settings.minutesPerKm,
  });

  // 5. Cria a entrega já no momento do pedido — não é preciso esperar a cozinha
  // pra o manager já poder planejar/atribuir entregador (correção sobre o
  // desenho original do §04, que sugeria criar isso só quando os itens
  // ficassem "ready"; o endereço já está resolvido aqui, então não há motivo
  // pra adiar, e adiar exigiria guardar o endereço em algum lugar intermediário).
  const delivery = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(deliveries)
      .values({
        orderId: order.id,
        address: addressText,
        status: "awaiting_courier",
        distanceKm: zoneKm,
        estimatedMinutes,
      })
      .returning();

    await enqueueEvent(tx, DELIVERY_ROOM, "delivery.created", { deliveryId: created.id, orderId: order.id });
    // Stage inicial "received" — o WS público (retomada por ?order=<id>)
    // e o polling do cliente partem do estado canônico da máquina.
    await emitCustomerStageChangedTx(tx, order.id);
    await logAction(tx, SYSTEM_USER_ID, "delivery_created", order.id, { channel: input.channel, addressText });

    return created;
  });

  const itemsTotal = items.reduce((sum: number, it: any) => sum + it.unitPrice * it.quantity, 0);
  const total = itemsTotal + (settings.deliveryFee ?? 0);

  return {
    orderId: order.id,
    deliveryId: delivery.id,
    total,
    deliveryFee: settings.deliveryFee,
    // Previsão real (preparo + viagem pela faixa escolhida). A tela abre ±20%
    // em volta — a janela, não este ponto, é o que vai pro cliente.
    estimatedMinutes,
    estimatedWindow: estimateWindow(estimatedMinutes),
  };
}

/**
 * Bloco de previsão que a tela de acompanhamento usa, recalculado a cada poll.
 *
 * A estimativa gravada no pedido é uma foto do momento da criação e vale para a
 * janela INTEIRA (preparo + viagem) enquanto o pedido está na cozinha. Quando o
 * entregador sai (`dispatchedAt`), a cozinha já cumpriu a parte dela e o que
 * sobra é o trajeto — a partir daí a previsão vira contagem a partir do
 * horário real de saída, que é mais honesto do que somar minutos numa base
 * antiga. É a diferença entre "38 min" ditado no pedido e "chega até 19:52"
 * depois que o motoboy pegou a encomenda.
 *
 * `remainingMinutes` é null enquanto o pedido não saiu: sem `dispatched_at` não
 * há base para contar, e devolver a estimativa inteira seria mentir sobre o que
 * falta.
 */
function etaForStage(
  delivery: typeof deliveries.$inferSelect | null | undefined,
  stage: string,
  prepMinutes: number,
  minutesPerKm: number
) {
  const estimatedMinutes = delivery?.estimatedMinutes ?? estimateDeliveryMinutes({ maxKm: null, prepMinutes, minutesPerKm });
  const eta = { estimatedMinutes, estimatedWindow: estimateWindow(estimatedMinutes) };

  const dispatchedAt = delivery?.dispatchedAt;
  if (stage !== "out_for_delivery" || !dispatchedAt) {
    return { ...eta, remainingMinutes: null as number | null };
  }

  // Tempo só de viagem: o preparo já foi consumido até o despacho.
  const travel = Math.max(0, estimatedMinutes - prepMinutes);
  const at = Date.parse(dispatchedAt);
  if (Number.isNaN(at)) return { ...eta, remainingMinutes: null as number | null };

  const remainingMinutes = Math.max(0, Math.round((at + travel * 60_000 - Date.now()) / 60_000));
  const window = estimateWindow(travel);
  return {
    ...eta,
    remainingMinutes,
    // Fim da janela de chegada, em ISO — a tela formata no fuso do cliente.
    deliverBy: new Date(at + window.max * 60_000).toISOString(),
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
  const settings = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });

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
    ...etaForStage(delivery, stage, settings?.deliveryPrepMinutes ?? 40, settings?.minutesPerKm ?? 2),
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
  const settings = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });

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
    // Mesma janela do endpoint de status: quem chega pela retomada precisa ver
    // a previsão que o cliente original recebeu, não um número diferente.
    ...etaForStage(delivery, stage, settings?.deliveryPrepMinutes ?? 40, settings?.minutesPerKm ?? 2),
    openedAt: active.openedAt,
  };
}
