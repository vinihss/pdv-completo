import { and, eq, notInArray, sql, desc } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import {
  orders,
  orderItems,
  orderPayments,
  products,
  storeSettings,
  restaurantTables,
  customers,
} from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { round2, moneyEq } from "../../domain/money.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

// NOTA IMPORTANTE sobre sync vs async:
// O driver better-sqlite3 é fundamentalmente síncrono — `db.transaction(cb)`
// exige que `cb` NÃO retorne uma Promise (lança "Transaction function cannot
// return a promise" caso contrário). Por isso, todo código DENTRO de uma
// transação usa os métodos terminais síncronos do Drizzle (`.run()`, `.get()`,
// `.all()`, `.sync()`) em vez de `await`. Fora de transações, `await db.query...`
// funciona normalmente (a API assíncrona do Drizzle "encapsula" o valor síncrono
// em uma Promise resolvida). Se um dia migrar pra Postgres (modo cloud), o
// driver (`pg`/`postgres-js`) é assíncrono de verdade — essas mesmas funções
// precisariam voltar a usar `async/await` dentro da transação. Ver 00-overview.md
// "mesmo código para SQLite local e Postgres cloud": isso é uma simplificação da
// spec original que não se sustenta 100% na prática por essa diferença de
// modelo de concorrência entre os drivers — vale registrar como débito técnico
// caso o modo cloud seja implementado depois.

async function getSettings() {
  const s = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (!s) throw new Error("store_settings não inicializado — rode o seed.");
  return s;
}

// Refs do produto no item: nome + foto + grupo de produção. A foto entra no
// próprio item pra tela da cozinha não precisar resolver listProducts inteiro
// (faz o caminho inverso: cozinha consome o que já veio na listagem de órden).
function serializeItem(
  it: typeof orderItems.$inferSelect,
  refs: { name: string; imagePath: string | null; kitchenGroupId: string | null }
) {
  return {
    id: it.id,
    orderId: it.orderId,
    productId: it.productId,
    name: refs.name,
    productImagePath: refs.imagePath,
    kitchenGroupId: refs.kitchenGroupId,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    selectedVariations: JSON.parse(it.selectedVariations),
    notes: it.notes,
    status: it.status,
    version: it.version,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
  };
}

async function serializeOrder(orderId: string) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) throw Errors.notFound("Comanda");
  const items = await db
    .select({
      item: orderItems,
      productName: products.name,
      productImagePath: products.imagePath,
      productKitchenGroupId: products.kitchenGroupId,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(eq(orderItems.orderId, orderId));

  const table = order.tableId
    ? await db.query.restaurantTables.findFirst({ where: eq(restaurantTables.id, order.tableId) })
    : null;
  const customer = order.customerId
    ? await db.query.customers.findFirst({ where: eq(customers.id, order.customerId) })
    : null;
  const payments = await db.query.orderPayments.findMany({ where: eq(orderPayments.orderId, orderId) });

  return {
    id: order.id,
    status: order.status,
    tableId: order.tableId,
    tableNumber: table?.number ?? null,
    customerId: order.customerId,
    customerName: customer?.name ?? null,
    tabLabel: order.tabLabel,
    waiterId: order.waiterId,
    channel: order.channel,
    externalRef: order.externalRef,
    deliveryFee: order.deliveryFee,
    cancelReason: order.cancelReason,
    paymentMethod: order.paymentMethod,
    paymentConfirmedAt: order.paymentConfirmedAt,
    paymentConfirmedBy: order.paymentConfirmedBy,
    openedAt: order.openedAt,
    closedAt: order.closedAt,
    items: items.map(({ item, productName, productImagePath, productKitchenGroupId }) =>
      serializeItem(item, {
        name: productName,
        imagePath: productImagePath,
        kitchenGroupId: productKitchenGroupId,
      })
    ),
    payments: payments.map(serializePayment),
  };
}

function serializePayment(p: typeof orderPayments.$inferSelect) {
  return {
    id: p.id,
    method: p.method,
    amount: p.amount,
    received: p.received,
    change: p.change,
    confirmed: p.confirmed,
    confirmedAt: p.confirmedAt,
    confirmedBy: p.confirmedBy,
  };
}

// Total da comanda a partir do snapshot unit_price (nunca o preço atual do
// produto), arredondado pra 2 casas. Itens "cancelled" não contam (mesma
// regra do relatório de vendas). Executa no contexto síncrono da transação.
function computeOrderTotal(tx: any, order: typeof orders.$inferSelect): number {
  const rows = tx
    .select({ unitPrice: orderItems.unitPrice, quantity: orderItems.quantity })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), notInArray(orderItems.status, ["cancelled"])))
    .all();
  const sum = rows.reduce((acc: number, r: { unitPrice: number; quantity: number }) => acc + r.unitPrice * r.quantity, 0);
  return round2(sum + (order.deliveryFee ?? 0));
}

// ---------- POST /orders ----------
export async function openOrderUsecase(input: {
  waiterId: string;
  tableId?: string;
  customerId?: string;
  tabLabel?: string;
  channel?: "balcao" | "whatsapp" | "web" | "ifood"; // default "balcao" — self-service (§04) e iFood usam
  deliveryFee?: number; // snapshot da taxa no momento do pedido, só para channel != "balcao"
  externalRef?: string; // order id do iFood quando channel === "ifood" (único — índice em 0009)
}) {
  if (!input.tableId && !input.customerId && !input.tabLabel) {
    throw Errors.identificationRequired();
  }

  const order = db.transaction((tx) => {
    const created = tx
      .insert(orders)
      .values({
        waiterId: input.waiterId,
        tableId: input.tableId ?? null,
        customerId: input.customerId ?? null,
        tabLabel: input.tabLabel ?? null,
        channel: input.channel ?? "balcao",
        deliveryFee: input.deliveryFee ?? null,
        externalRef: input.externalRef ?? null,
      })
      .returning()
      .get();

    if (input.tableId) {
      tx.update(restaurantTables).set({ status: "occupied" }).where(eq(restaurantTables.id, input.tableId)).run();
      enqueueEvent(tx, `table:${input.tableId}`, "table.status_changed", {
        tableId: input.tableId,
        status: "occupied",
      });
    }

    logAction(tx, input.waiterId, "order_opened", created.id, {
      tableId: input.tableId,
      customerId: input.customerId,
      tabLabel: input.tabLabel,
    });

    return created;
  });

  return serializeOrder(order.id);
}

// ---------- POST /orders/:id/items ----------
export async function addItemsUsecase(input: {
  orderId: string;
  userId: string;
  items: Array<{
    productId: string;
    quantity: number;
    selectedVariations?: Record<string, string | string[]>;
    notes?: string;
  }>;
}) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order) throw Errors.notFound("Comanda");
  if (order.status !== "open") throw Errors.orderNotOpen();

  const settings = await getSettings();

  const createdItems = db.transaction((tx) => {
    const result: any[] = [];
    for (const line of input.items) {
      const product = tx.query.products.findFirst({ where: eq(products.id, line.productId) }).sync();
      if (!product || !product.active) {
        throw Errors.validationFailed({ productId: line.productId, reason: "inativo ou inexistente" });
      }
      // Status de entrada por estação/modo (§7.2, kitchen_enabled):
      // - sem cozinha (pub): item já entra entregue — a comanda não controla
      //   preparo/entrega e não exige confirmação do garçom;
      // - com cozinha + grupo de produção: entra na fila da estação (ordered);
      // - com cozinha sem grupo (bar/copa): entra pronto (ready) — só falta entregar.
      const hasStation = settings.kitchenEnabled && Boolean(product.kitchenGroupId);
      const initialStatus = !settings.kitchenEnabled ? "delivered" : hasStation ? "ordered" : "ready";
      const created = tx
        .insert(orderItems)
        .values({
          orderId: input.orderId,
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: product.price, // snapshot — nunca referência viva
          selectedVariations: JSON.stringify(line.selectedVariations ?? {}),
          notes: line.notes ?? null,
          createdBy: input.userId,
          status: initialStatus,
        })
        .returning()
        .get();
      const serialized = serializeItem(created, {
        name: product.name,
        imagePath: product.imagePath,
        kitchenGroupId: product.kitchenGroupId,
      });
      result.push(serialized);

      enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.item.created", {
        orderId: input.orderId,
        item: serialized,
      });
      // Roteamento por estação: só entra na fila da cozinha quando há cozinha
      // E o produto tem grupo de produção. Bar/copa e modo pub não emitem.
      if (hasStation) {
        enqueueEvent(tx, "kitchen-display", "order.item.created", {
          orderId: input.orderId,
          item: serialized,
        });
      }
    }

    logAction(tx, input.userId, "item_added", input.orderId, { items: result });
    return result;
  });

  return createdItems;
}

// ---------- PATCH /orders/:id/items/:itemId ----------
export async function updateItemStatusUsecase(input: {
  orderId: string;
  itemId: string;
  userId: string;
  userRole: "waiter" | "kitchen" | "manager" | "courier";
  newStatus: "ready" | "delivered";
  expectedVersion: number;
}) {
  const settings = await getSettings();
  const item = await db.query.orderItems.findFirst({ where: eq(orderItems.id, input.itemId) });
  if (!item || item.orderId !== input.orderId) throw Errors.notFound("Item");

  // Validação de transição por modo (§7.2, kitchen_enabled)
  if (settings.kitchenEnabled) {
    if (input.newStatus === "ready" && item.status !== "ordered") throw Errors.invalidTransition();
    if (input.newStatus === "delivered" && item.status !== "ready") throw Errors.invalidTransition();
  } else {
    if (input.newStatus === "ready") throw Errors.invalidTransition("Não há estação de cozinha neste modo.");
    if (input.newStatus === "delivered" && item.status !== "ordered") throw Errors.invalidTransition();
  }
  if (item.status === "delivered") throw Errors.invalidTransition();

  // Role: ready exige kitchen/manager; delivered exige waiter/manager
  if (input.newStatus === "ready" && !["kitchen", "manager"].includes(input.userRole)) throw Errors.forbiddenRole();
  if (input.newStatus === "delivered" && !["waiter", "manager"].includes(input.userRole)) throw Errors.forbiddenRole();

  const updated = db.transaction((tx) => {
    const result = tx
      .update(orderItems)
      .set({ status: input.newStatus, version: sql`${orderItems.version} + 1`, updatedAt: new Date().toISOString() })
      .where(and(eq(orderItems.id, input.itemId), eq(orderItems.version, input.expectedVersion)))
      .returning()
      .all();

    if (result.length === 0) {
      const current = tx.query.orderItems.findFirst({ where: eq(orderItems.id, input.itemId) }).sync();
      throw Errors.concurrencyConflict(current?.version ?? -1);
    }

    const parentOrder = tx.query.orders.findFirst({ where: eq(orders.id, input.orderId) }).sync();
    enqueueEvent(tx, `table:${parentOrder?.tableId ?? input.orderId}`, "order.item.status_changed", {
      orderId: input.orderId,
      itemId: input.itemId,
      status: input.newStatus,
      changedBy: input.userId,
    });
    enqueueEvent(tx, "kitchen-display", "order.item.status_changed", {
      orderId: input.orderId,
      itemId: input.itemId,
      status: input.newStatus,
      changedBy: input.userId,
    });

    const action = input.newStatus === "delivered" ? "item_delivered" : "item_ready";
    logAction(tx, input.userId, action, input.orderId, { itemId: input.itemId });

    return result[0];
  });

  return { ...updated, selectedVariations: JSON.parse(updated.selectedVariations) };
}

// ---------- DELETE /orders/:id/items/:itemId ----------
export async function deleteItemUsecase(input: { orderId: string; itemId: string; userId: string }) {
  const settings = await getSettings();
  const item = await db.query.orderItems.findFirst({ where: eq(orderItems.id, input.itemId) });
  if (!item || item.orderId !== input.orderId) throw Errors.notFound("Item");
  // Modo sem cozinha: a comanda não controla status — item já entra entregue,
  // então exclusão por engano continua permitida. Com cozinha, item entregue é imutável.
  if (settings.kitchenEnabled && item.status === "delivered") throw Errors.itemAlreadyDelivered();

  db.transaction((tx) => {
    tx.delete(orderItems).where(eq(orderItems.id, input.itemId)).run();
    logAction(tx, input.userId, "item_removed", input.orderId, { itemId: input.itemId, name: item.productId });
  });
}

// ---------- PUT /orders/:id/payments, PATCH/DELETE /orders/:id/payments/:paymentId ----------

type PaymentLineInput = {
  method: "cash" | "card" | "pix" | "other";
  amount: number;
  received?: number;
  confirmed?: boolean;
};

// Aplica as linhas de pagamento: apaga as anteriores e insere as novas, na
// mesma transação da escrita (padrão do repo). `orders.payment_method` continua
// como denormalizado de exibição — método único → ele; mais de um → null
// (o client consome `payments[]` pra exibir o detalhe).
function upsertPaymentLines(tx: any, order: typeof orders.$inferSelect, userId: string, lines: PaymentLineInput[]) {
  tx.delete(orderPayments).where(eq(orderPayments.orderId, order.id)).run();

  const created: any[] = [];
  for (const line of lines) {
    const isCash = line.method === "cash";
    const confirmed = Boolean(line.confirmed);
    const received = isCash ? (line.received != null ? line.received : line.amount) : null;
    if (isCash && confirmed && received != null && received < line.amount) {
      throw Errors.validationFailed({ field: "received", reason: "dinheiro recebido menor que o valor a pagar" });
    }
    const change = isCash && received != null ? round2(received - line.amount) : null;
    const row = tx
      .insert(orderPayments)
      .values({
        orderId: order.id,
        method: line.method,
        amount: round2(line.amount),
        received,
        change,
        confirmed,
        confirmedAt: confirmed ? new Date().toISOString() : null,
        confirmedBy: confirmed ? userId : null,
        createdBy: userId,
      })
      .returning()
      .get();
    created.push(serializePayment(row));
  }

  const methods = [...new Set(lines.map((l) => l.method))];
  const allConfirmed = created.length > 0 && created.every((p) => p.confirmed);
  tx.update(orders)
    .set({
      paymentMethod: methods.length === 1 ? methods[0] : null,
      paymentConfirmedAt: allConfirmed ? new Date().toISOString() : null,
      paymentConfirmedBy: allConfirmed ? userId : null,
    })
    .where(eq(orders.id, order.id))
    .run();

  return created;
}

export async function setOrderPaymentsUsecase(input: {
  orderId: string;
  userId: string;
  payments: PaymentLineInput[];
}) {
  const settings = await getSettings();
  const enabled: string[] = JSON.parse(settings.enabledPaymentMethods);
  if (input.payments.length === 0) {
    throw Errors.validationFailed({ field: "payments", reason: "informe ao menos uma forma de pagamento" });
  }

  const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order) throw Errors.notFound("Comanda");
  if (order.status !== "open") throw Errors.orderNotOpen();

  for (const p of input.payments) {
    if (!enabled.includes(p.method)) throw Errors.paymentMethodDisabled();
    if (!(p.amount > 0)) throw Errors.validationFailed({ field: "amount", reason: "valor deve ser maior que zero" });
  }

  const updated = db.transaction((tx) => {
    const total = computeOrderTotal(tx, order);
    const sum = round2(input.payments.reduce((acc, p) => acc + p.amount, 0));
    if (!moneyEq(sum, total)) throw Errors.invalidPaymentTotal();

    const created = upsertPaymentLines(tx, order, input.userId, input.payments);
    logAction(tx, input.userId, "payment_registered", input.orderId, { payments: created });
    enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.payment_changed", {
      orderId: input.orderId,
      payments: created,
    });
    return created;
  });

  return serializeOrder(input.orderId);
}

export async function confirmOrderPaymentUsecase(input: { orderId: string; paymentId: string; userId: string }) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order) throw Errors.notFound("Comanda");
  if (order.status !== "open") throw Errors.orderNotOpen();

  const updated = db.transaction((tx) => {
    const payment = tx.query.orderPayments.findFirst({ where: eq(orderPayments.id, input.paymentId) }).sync();
    if (!payment || payment.orderId !== input.orderId) throw Errors.notFound("Pagamento");
    if (payment.confirmed) return payment;

    const result = tx
      .update(orderPayments)
      .set({ confirmed: true, confirmedAt: new Date().toISOString(), confirmedBy: input.userId })
      .where(eq(orderPayments.id, input.paymentId))
      .returning()
      .get();

    const all = tx.select().from(orderPayments).where(eq(orderPayments.orderId, input.orderId)).all();
    if (all.length > 0 && all.every((p) => p.confirmed)) {
      tx.update(orders)
        .set({ paymentConfirmedAt: new Date().toISOString(), paymentConfirmedBy: input.userId })
        .where(eq(orders.id, input.orderId))
        .run();
    }

    logAction(tx, input.userId, "payment_confirmed", input.orderId, { paymentId: input.paymentId, method: payment.method });
    enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.payment_changed", {
      orderId: input.orderId,
      paymentId: input.paymentId,
      confirmed: true,
    });
    return result;
  });

  return serializePayment(updated);
}

export async function deleteOrderPaymentUsecase(input: { orderId: string; paymentId: string; userId: string }) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order) throw Errors.notFound("Comanda");
  if (order.status !== "open") throw Errors.orderNotOpen();

  db.transaction((tx) => {
    const payment = tx.query.orderPayments.findFirst({ where: eq(orderPayments.id, input.paymentId) }).sync();
    if (!payment || payment.orderId !== input.orderId) throw Errors.notFound("Pagamento");
    if (payment.confirmed) throw Errors.invalidTransition("Pagamento já confirmado não pode ser removido.");
    tx.delete(orderPayments).where(eq(orderPayments.id, input.paymentId)).run();
    logAction(tx, input.userId, "payment_removed", input.orderId, { paymentId: input.paymentId, method: payment.method });
    enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.payment_changed", { orderId: input.orderId });
  });
}

// ---------- PATCH /orders/:id/payment (legado) ----------
// Adaptador sobre o modelo fracionado: transforma o registro antigo (método
// único, sem valor) em uma única linha de 100% do total. Mantém o fluxo
// self-service/entrega funcionando sem mudança (intenção confirmed:false no
// checkout; confirmação confirmed:true na entrega).
export async function registerPaymentUsecase(input: {
  orderId: string;
  userId: string;
  paymentMethod: "cash" | "card" | "pix" | "other";
  confirmed: boolean;
}) {
  const settings = await getSettings();
  const enabled: string[] = JSON.parse(settings.enabledPaymentMethods);
  if (!enabled.includes(input.paymentMethod)) throw Errors.paymentMethodDisabled();

  const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order) throw Errors.notFound("Comanda");
  if (order.status !== "open") throw Errors.orderNotOpen();

  const updated = db.transaction((tx) => {
    const total = computeOrderTotal(tx, order);
    const created = upsertPaymentLines(tx, order, input.userId, [
      { method: input.paymentMethod, amount: total, confirmed: input.confirmed },
    ]);
    logAction(tx, input.userId, "payment_registered", input.orderId, {
      paymentMethod: input.paymentMethod,
      confirmed: input.confirmed,
    });
    enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.payment_changed", {
      orderId: input.orderId,
      payments: created,
    });
    return created[0];
  });

  return updated;
}

// ---------- PATCH /orders/:id/close ----------
export async function closeOrderUsecase(input: { orderId: string; userId: string }) {
  const closed = db.transaction((tx) => {
    const order = tx.query.orders.findFirst({ where: eq(orders.id, input.orderId) }).sync();
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    const pending = tx
      .select({ item: orderItems, productName: products.name })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(eq(orderItems.orderId, input.orderId), notInArray(orderItems.status, ["delivered", "cancelled"])))
      .all();

    if (pending.length > 0) {
      throw Errors.pendingItems(
        pending.map(({ item, productName }: any) => ({
          id: item.id,
          name: productName,
          quantity: item.quantity,
          status: item.status,
        }))
      );
    }

    // Pagamento fracionado: exige ao menos uma linha, todas confirmadas e a
    // soma conferindo com o total (evita fechar com "intenção" de Pix ainda
    // não recebida, ou com divisão que não cobre a conta).
    const payments = tx.select().from(orderPayments).where(eq(orderPayments.orderId, input.orderId)).all();
    if (payments.length === 0) throw Errors.paymentNotRegistered();
    if (payments.some((p) => !p.confirmed)) throw Errors.paymentNotConfirmed();

    const total = computeOrderTotal(tx, order);
    const paid = round2(payments.reduce((acc, p) => acc + p.amount, 0));
    if (!moneyEq(paid, total)) throw Errors.invalidPaymentTotal();

    const result = tx
      .update(orders)
      .set({ status: "closed", closedAt: new Date().toISOString() })
      .where(eq(orders.id, input.orderId))
      .returning()
      .get();

    if (order.tableId) {
      tx.update(restaurantTables).set({ status: "free" }).where(eq(restaurantTables.id, order.tableId)).run();
      enqueueEvent(tx, `table:${order.tableId}`, "table.status_changed", {
        tableId: order.tableId,
        status: "free",
      });
    }

    enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.closed", {
      orderId: order.id,
      tableId: order.tableId,
    });

    logAction(tx, input.userId, "order_closed", input.orderId, {
      payments: payments.map(serializePayment),
    });
    return result;
  });

  return closed;
}

// ---------- PATCH /orders/:id/cancel ----------
/**
 * Só existe porque a fase de delivery expôs um buraco que já existia pro
 * app inteiro: nenhum caminho fechava um pedido que não terminasse em venda
 * (ex: entrega marcada "failed" — deliveries.status vira "failed", mas
 * orders.status ficava "open" pra sempre, sem paymentMethod nem itens
 * "delivered", então closeOrderUsecase nunca aceitaria). Diferente de
 * closeOrderUsecase, não exige pagamento nem itens já entregues — cancelar
 * é precisamente o caminho pra quando a venda não vai acontecer.
 */
export async function cancelOrderUsecase(input: { orderId: string; userId: string; reason: string }) {
  const cancelled = db.transaction((tx) => {
    const order = tx.query.orders.findFirst({ where: eq(orders.id, input.orderId) }).sync();
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    tx.update(orderItems)
      .set({ status: "cancelled" })
      .where(and(eq(orderItems.orderId, input.orderId), notInArray(orderItems.status, ["delivered", "cancelled"])))
      .run();

    const result = tx
      .update(orders)
      .set({ status: "cancelled", closedAt: new Date().toISOString(), cancelReason: input.reason })
      .where(eq(orders.id, input.orderId))
      .returning()
      .get();

    if (order.tableId) {
      tx.update(restaurantTables).set({ status: "free" }).where(eq(restaurantTables.id, order.tableId)).run();
      enqueueEvent(tx, `table:${order.tableId}`, "table.status_changed", {
        tableId: order.tableId,
        status: "free",
      });
    }

    enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.cancelled", {
      orderId: order.id,
      tableId: order.tableId,
    });

    logAction(tx, input.userId, "order_cancelled", input.orderId, { reason: input.reason });
    return result;
  });

  return cancelled;
}

// ---------- GET /orders, GET /orders/:id, GET /tables ----------
export async function getOrderUsecase(orderId: string) {
  return serializeOrder(orderId);
}

export async function listOrdersUsecase(input: { status?: "open" | "closed"; limit: number; offset: number }) {
  const where = input.status ? eq(orders.status, input.status) : undefined;
  const rows = await db.query.orders.findMany({
    where,
    orderBy: desc(orders.openedAt),
    limit: input.limit,
    offset: input.offset,
  });
  const data = await Promise.all(rows.map((o) => serializeOrder(o.id)));
  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(orders).where(where as any);
  return { data, total: totalRow[0]?.count ?? data.length };
}

export async function listTablesUsecase() {
  return db.query.restaurantTables.findMany({ orderBy: (t, { asc }) => asc(t.number) });
}
