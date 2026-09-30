import { and, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, type Tx } from "../../infra/db/client.js";
import {
  orders,
  orderItems,
  orderPayments,
  cashDrawerMovements,
  products,
  storeSettings,
  restaurantTables,
  customers,
  stockMovements,
  deliveries,
} from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { round2, moneyEq } from "../../domain/money.js";
import { canTransitionDelivery } from "../../domain/customer-order-state.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { emitCustomerStageChangedTx } from "../self-service/customer-stage.js";
import { notifyReady } from "../../integrations/whatsapp/whatsapp.notifier.js";
import { printKitchenOrder } from "../../integrations/printer/printer.usecases.js";
import { findOpenDrawerTx } from "../cash-flow/cash-flow.usecases.js";
import { applyStockMovementTx, stockBalance, computeMovingAverageTx, INVENTORY_ROOM } from "../stock/stock.usecases.js";
import { createAlertTx, describeOrderAlert, ORDER_ALERT_KIND, ORDER_ALERT_AUDIENCE } from "../alert/alert.usecases.js";
import { getCache } from "../../infra/cache/index.js";

const cache = getCache();

// NOTA IMPORTANTE sobre async (leia antes de tocar em qualquer transação):
// O banco oficial é Postgres, e o driver node-postgres é assíncrono de
// verdade. `db.transaction(cb)` entrega a `cb` uma `tx` cujo método é
// SEMPRE uma Promise, então dentro de uma transação tudo é `await`:
//
//   await db.transaction(async (tx) => {
//     const [row] = await tx.insert(orders).values({...}).returning();
//     await tx.update(...).set({...}).where(...);
//   });
//
// Os antigos terminais síncronos do better-sqlite3 (`.run()`, `.get()`,
// `.all()`, `.sync()`) NÃO existem aqui — usá-los era obrigatório quando o
// callback de `db.transaction` não podia retornar Promise. Esquecer um
// `await` dentro da transação é o erro perigoso desta camada: o INSERT pode
// ser emitido depois do COMMIT e a escrita se perder silenciosamente, então
// todo `.insert/.update/.delete/.select` dentro de `tx` precisa de `await`.
//
// O `throw` continua sendo o mecanismo de rollback (a transação aborta e o
// drizzle propaga o erro), então os AppError de domínio seguem funcionando
// igual.

export async function getSettings() {
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
    costPrice: it.costPrice, // snapshot do custo no lançamento (margem)
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
  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.orderId, orderId) });

  return {
    id: order.id,
    status: order.status,
    tableId: order.tableId,
    tableNumber: table?.number ?? null,
    customerId: order.customerId,
    customerName: customer?.name ?? null,
    // O mapper de impressão do daemon (frontend entities/printer) já esperava
    // estes dois campos e nunca os recebia: o cupom do entregador impresso pelo
    // botão do app saía sem telefone e sem endereço. A impressão automática do
    // backend já mandava (printer.usecases.ts).
    customerPhone: customer?.phone ?? null,
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
    delivery: delivery ? serializeDelivery(delivery) : null,
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

// Entrega da comanda (1:1, `delivery.order_id` é UNIQUE). Fica embutida em
// vez de a tela da comanda cruzar com `GET /manager/deliveries` — que é
// restrito ao gerente e não existe pro garçom, que é quem abre a comanda.
function serializeDelivery(d: typeof deliveries.$inferSelect) {
  return {
    id: d.id,
    status: d.status,
    address: d.address,
    notes: d.notes,
    courierId: d.courierId,
    dispatchedAt: d.dispatchedAt,
    deliveredAt: d.deliveredAt,
  };
}

// Total da comanda a partir do snapshot unit_price (nunca o preço atual do
// produto), arredondado pra 2 casas. Itens "cancelled" não contam (mesma
// regra do relatório de vendas). Roda dentro da transação do fechamento.
async function computeOrderTotal(tx: Tx, order: typeof orders.$inferSelect): Promise<number> {
  const rows = await tx
    .select({ unitPrice: orderItems.unitPrice, quantity: orderItems.quantity })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), notInArray(orderItems.status, ["cancelled"])));
  const sum = rows.reduce((acc, r) => acc + r.unitPrice * r.quantity, 0);
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

  const order = await db.transaction(async (tx) => {
    // 1.6 — valida a mesa antes de abrir: inexistente → 404; ocupada → 409.
    // Só vale para abertura física de comanda (channel default "balcao");
    // self-service e iFood não parametrizam mesa.
    //
    // No Postgres o "ler status e depois gravar" NÃO é atômico (o SQLite
    // serializava as escritas; aqui duas requisições simultâneas podem ler
    // `free` ao mesmo tempo e abrir duas comandas na mesma mesa). Por isso a
    // ocupação é um UPDATE condicional: o `status = 'free'` é reavaliado sob o
    // lock de linha, então só uma transação consegue mudar free -> occupied.
    if (input.tableId) {
      const claimed = await tx
        .update(restaurantTables)
        .set({ status: "occupied" })
        .where(and(eq(restaurantTables.id, input.tableId), eq(restaurantTables.status, "free")))
        .returning({ id: restaurantTables.id });
      if (claimed.length === 0) {
        // Nenhuma linha alterada: ou a mesa não existe, ou já está ocupada.
        // Uma leitura só aqui (o caminho feliz não paga essa query) decide
        // entre 404 e 409 sem reintroduzir a corrida.
        const table = await tx.query.restaurantTables.findFirst({
          where: eq(restaurantTables.id, input.tableId),
        });
        if (!table) throw Errors.tableNotFound(input.tableId);
        throw Errors.tableOccupied();
      }
    }

    const [created] = await tx
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
      .returning();

    if (input.tableId) {
      await enqueueEvent(tx, `table:${input.tableId}`, "table.status_changed", {
        tableId: input.tableId,
        status: "occupied",
      });
    }

    await logAction(tx, input.waiterId, "order_opened", created.id, {
      tableId: input.tableId,
      customerId: input.customerId,
      tabLabel: input.tabLabel,
    });

    // Alerta do sino (0004). Fica AQUI, e não em cada canal, porque todos os
    // quatro passam por esta função: balcão (`POST /orders`), self-service
    // (order-intake), iFood (ingest) e qualquer canal novo. Se ficasse em cada
    // chamador, um canal novo nasceria mudo.
    //
    // O texto precisa do número da mesa / nome do cliente, que a linha do
    // pedido não traz (só os ids) — por isso as duas leituras abaixo. São
    // leituras por PK dentro de uma transação que já fez UPDATE condicional +
    // INSERT + logAction, então o custo é desprezível e o ganho (alerta legível
    // "Nova comanda · Mesa 3") é todo para quem lê.
    const channel = input.channel ?? "balcao";
    const [table, customer] = await Promise.all([
      input.tableId ? tx.query.restaurantTables.findFirst({ where: eq(restaurantTables.id, input.tableId) }) : null,
      input.customerId ? tx.query.customers.findFirst({ where: eq(customers.id, input.customerId) }) : null,
    ]);
    const { title, body } = describeOrderAlert({
      channel,
      // Para mesa, o rótulo é o número da pessoa — um id de mesa no alerta
      // seria inútil. Sem mesa (pub/cliente), o tabLabel é o rótulo de verdade.
      label: input.tableId ? (table?.number ? `Mesa ${table.number}` : "Mesa") : input.tabLabel,
      customerName: (customer as any)?.name,
    });
    await createAlertTx(tx, {
      kind: ORDER_ALERT_KIND,
      title,
      body,
      orderId: created.id,
      channel,
      audience: ORDER_ALERT_AUDIENCE,
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

  const createdItems = await db.transaction(async (tx) => {
    const result: ReturnType<typeof serializeItem>[] = [];
    for (const line of input.items) {
      const product = await tx.query.products.findFirst({ where: eq(products.id, line.productId) });
      if (!product || !product.active) {
        throw Errors.validationFailed({ productId: line.productId, reason: "inativo ou inexistente" });
      }
      // Estoque (003/0016): com a feature global ligada E produto rastreando,
      // o saldo do ledger é o teto — lançar mais que disponível bloqueia a
      // comanda inteira (a transação inteira faz rollback no throw). Requer
      // saldo do ledger, nunca coluna cacheada.
      const deductsStock = settings.inventoryEnabled && product.trackStock;
      if (deductsStock) {
        const available = await stockBalance(tx, product.id);
        if (available < line.quantity) throw Errors.insufficientStock(product.id, product.name, available);
      }
      // Status de entrada por estação/modo (§7.2, kitchen_enabled):
      // - sem cozinha (pub): item já entra entregue — a comanda não controla
      //   preparo/entrega e não exige confirmação do garçom;
      // - com cozinha + grupo de produção: entra na fila da estação (ordered);
      // - com cozinha sem grupo (bar/copa): entra pronto (ready) — só falta entregar.
      const hasStation = settings.kitchenEnabled && Boolean(product.kitchenGroupId);
      const initialStatus = !settings.kitchenEnabled ? "delivered" : hasStation ? "ordered" : "ready";
      const [created] = await tx
        .insert(orderItems)
        .values({
          orderId: input.orderId,
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: product.price, // snapshot — nunca referência viva
          // Snapshot do custo no lançamento (margem): com a feature global e
          // compras ligadas, usa a média móvel do ledger naquele instante;
          // senão, o cost_price manual do cadastro (comportamento 0016).
          costPrice:
            settings.inventoryEnabled && settings.purchaseEnabled && product.trackStock
              ? (await computeMovingAverageTx(tx, product.id, product.costPrice)).avg
              : product.costPrice,
          selectedVariations: JSON.stringify(line.selectedVariations ?? {}),
          notes: line.notes ?? null,
          createdBy: input.userId,
          status: initialStatus,
        })
        .returning();
      const serialized = serializeItem(created, {
        name: product.name,
        imagePath: product.imagePath,
        kitchenGroupId: product.kitchenGroupId,
      });
      result.push(serialized);

      // Débito do estoque no mesmo commit do item (rollback garante que item
      // e saldo nunca divergem). Eventos stock.movement/stock.low vão pro
      // room "inventory" — quem assina (aba Estoque do gerente) atualiza.
      if (deductsStock) {
        const { balance } = await applyStockMovementTx(tx, {
          productId: product.id,
          type: "sale",
          quantityDelta: -line.quantity,
          orderId: input.orderId,
          orderItemId: created.id,
          createdBy: input.userId,
        });
        if (product.trackStock && product.lowStockThreshold > 0 && balance <= product.lowStockThreshold) {
          await enqueueEvent(tx, INVENTORY_ROOM, "stock.low", {
            productId: product.id,
            name: product.name,
            quantity: balance,
            threshold: product.lowStockThreshold,
          });
        }
      }

      await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.item.created", {
        orderId: input.orderId,
        item: serialized,
      });
      // Roteamento por estação: só entra na fila da cozinha quando há cozinha
      // E o produto tem grupo de produção. Bar/copa e modo pub não emitem.
      if (hasStation) {
        await enqueueEvent(tx, "kitchen-display", "order.item.created", {
          orderId: input.orderId,
          item: serialized,
        });
      }
    }

    await logAction(tx, input.userId, "item_added", input.orderId, { items: result });
    return result;
  });

  // Impressão automática da cozinha (pós-commit, fire-and-forget): só quando
  // as duas flags estão ligadas E o modo cozinha está ativo. O daemon tem
  // fila de retry própria; falha aqui nunca quebra o lançamento.
  if (settings.printerEnabled && settings.printerAutoPrint && settings.kitchenEnabled) {
    printKitchenOrder(input.orderId).catch((err) => console.error("falha ao imprimir comanda na cozinha:", err));
  }

  return createdItems;
}

// ---------- PATCH /orders/:id/items/:itemId ----------
export async function updateItemStatusUsecase(input: {
  orderId: string;
  itemId: string;
  userId: string;
  userRole: "waiter" | "kitchen" | "manager" | "courier" | "cashier";
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

  // Último item pronto do pedido self-service muda o stage (preparing →
  // ready) e notifica o cliente no WhatsApp — a página pública e o bot
  // consomem o evento customer.stage_changed (room order:<orderId>).
  let readyNotifyOrderId: string | null = null;
  const updated = await db.transaction(async (tx) => {
    const result = await tx
      .update(orderItems)
      .set({ status: input.newStatus, version: sql`${orderItems.version} + 1`, updatedAt: new Date().toISOString() })
      .where(and(eq(orderItems.id, input.itemId), eq(orderItems.version, input.expectedVersion)))
      .returning();

    if (result.length === 0) {
      const current = await tx.query.orderItems.findFirst({ where: eq(orderItems.id, input.itemId) });
      throw Errors.concurrencyConflict(current?.version ?? -1);
    }

    const parentOrder = await tx.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
    await enqueueEvent(tx, `table:${parentOrder?.tableId ?? input.orderId}`, "order.item.status_changed", {
      orderId: input.orderId,
      itemId: input.itemId,
      status: input.newStatus,
      changedBy: input.userId,
    });
    await enqueueEvent(tx, "kitchen-display", "order.item.status_changed", {
      orderId: input.orderId,
      itemId: input.itemId,
      status: input.newStatus,
      changedBy: input.userId,
    });

    // Só pra comanda de delivery (whatsapp/web) — comanda de mesa não tem
    // máquina de cliente (nobody assina order:<orderId> de mesa). O stage
    // só muda de fato quando o ÚLTIMO item ativo fica pronto.
    const isSelfService = parentOrder?.channel === "whatsapp" || parentOrder?.channel === "web";
    if (isSelfService && input.newStatus === "ready") {
      const allItems = await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, input.orderId) });
      const activeItems = allItems.filter((i) => i.status !== "cancelled");
      if (activeItems.length > 0 && activeItems.every((i) => i.status === "ready" || i.status === "delivered")) {
        await emitCustomerStageChangedTx(tx, input.orderId);
        readyNotifyOrderId = input.orderId;
      }
    }

    const action = input.newStatus === "delivered" ? "item_delivered" : "item_ready";
    await logAction(tx, input.userId, action, input.orderId, { itemId: input.itemId });

    return result[0];
  });

  if (readyNotifyOrderId) {
    notifyReady(readyNotifyOrderId).catch((err) => console.error("falha ao notificar pedido pronto pro cliente:", err));
  }

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

  await db.transaction(async (tx) => {
    // Estorno de estoque: se o item consumiu stock no lançamento (movimento
    // 'sale' vinculado ao item existe), devolve o mesmo volume como 'refund'.
    // Baseado no ledger (e não no flag atual do produto) — a decisão de
    // repor é "houve consumo", então o ledger continua consistente mesmo se
    // o produto deixou de rastrear estoque depois.
    const sales = await tx
      .select({ quantityDelta: stockMovements.quantityDelta })
      .from(stockMovements)
      .where(and(eq(stockMovements.orderItemId, input.itemId), eq(stockMovements.type, "sale")));
    for (const sale of sales) {
      await applyStockMovementTx(tx, {
        productId: item.productId,
        type: "refund",
        quantityDelta: -sale.quantityDelta, // sale é negativo → refund positivo
        orderId: input.orderId,
        orderItemId: input.itemId,
        note: "Item removido",
        createdBy: input.userId,
      });
    }

    await tx.delete(orderItems).where(eq(orderItems.id, input.itemId));
    await logAction(tx, input.userId, "item_removed", input.orderId, { itemId: input.itemId, name: item.productId });
    // 1.8 — item removido em um terminal precisa sumir dos demais (garçom/gerente
    // assinam "kitchen-display"; "table:{id}" não é assinado por ninguém).
    await enqueueEvent(tx, `table:${item.orderId}`, "order.item.removed", {
      orderId: input.orderId,
      itemId: input.itemId,
    });
    await enqueueEvent(tx, "kitchen-display", "order.item.removed", {
      orderId: input.orderId,
      itemId: input.itemId,
    });
  });
}

// ---------- PUT /orders/:id/payments, PATCH/DELETE /orders/:id/payments/:paymentId ----------

type PaymentLineInput = {
  method: "cash" | "card" | "pix" | "other";
  amount: number;
  received?: number;
  confirmed?: boolean;
};

// Corretude do fluxo de caixa: pagamento em dinheiro confirmado só entra com
// caixa aberto no momento — senão a venda fica fora de qualquer sessão e a
// conferência da gaveta quebra. Roda na mesma transação da escrita do
// pagamento (no caso do fechamento do caixa, o pagamento/estorno roda depois
// da sessão ter sido marcada fechada e é rejeitado).
async function requireOpenDrawerForCash(tx: Tx, method: string, confirmed: boolean) {
  if (method === "cash" && confirmed && !(await findOpenDrawerTx(tx))) {
    throw Errors.paymentRequiresOpenDrawer();
  }
}

// Aplica as linhas de pagamento: apaga as anteriores e insere as novas, na
// mesma transação da escrita (padrão do repo). `orders.payment_method` continua
// como denormalizado de exibição — método único → ele; mais de um → null
// (o client consome `payments[]` pra exibir o detalhe).
async function upsertPaymentLines(tx: Tx, order: typeof orders.$inferSelect, userId: string, lines: PaymentLineInput[]) {
  await tx.delete(orderPayments).where(eq(orderPayments.orderId, order.id));

  const created: ReturnType<typeof serializePayment>[] = [];
  for (const line of lines) {
    await requireOpenDrawerForCash(tx, line.method, Boolean(line.confirmed));
    const isCash = line.method === "cash";
    const confirmed = Boolean(line.confirmed);
    const received = isCash ? (line.received != null ? line.received : line.amount) : null;
    if (isCash && confirmed && received != null && received < line.amount) {
      throw Errors.validationFailed({ field: "received", reason: "dinheiro recebido menor que o valor a pagar" });
    }
    const change = isCash && received != null ? round2(received - line.amount) : null;
    const [row] = await tx
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
      .returning();
    created.push(serializePayment(row));
  }

  const methods = [...new Set(lines.map((l) => l.method))];
  const allConfirmed = created.length > 0 && created.every((p) => p.confirmed);
  await tx
    .update(orders)
    .set({
      paymentMethod: methods.length === 1 ? methods[0] : null,
      paymentConfirmedAt: allConfirmed ? new Date().toISOString() : null,
      paymentConfirmedBy: allConfirmed ? userId : null,
    })
    .where(eq(orders.id, order.id));

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

  await db.transaction(async (tx) => {
    const total = await computeOrderTotal(tx, order);
    const sum = round2(input.payments.reduce((acc, p) => acc + p.amount, 0));
    if (!moneyEq(sum, total)) throw Errors.invalidPaymentTotal();

    const created = await upsertPaymentLines(tx, order, input.userId, input.payments);
    await logAction(tx, input.userId, "payment_registered", input.orderId, { payments: created });
    await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.payment_changed", {
      orderId: input.orderId,
      payments: created,
    });
    await enqueueEvent(tx, "cash-drawer", "order.payment_changed", {
      orderId: input.orderId,
      payments: created,
    });
    await enqueueEvent(tx, "kitchen-display", "order.payment_changed", {
      orderId: input.orderId,
      payments: created,
    });
  });

  return serializeOrder(input.orderId);
}

export async function confirmOrderPaymentUsecase(input: { orderId: string; paymentId: string; userId: string }) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order) throw Errors.notFound("Comanda");
  if (order.status !== "open") throw Errors.orderNotOpen();

  const updated = await db.transaction(async (tx) => {
    const payment = await tx.query.orderPayments.findFirst({ where: eq(orderPayments.id, input.paymentId) });
    if (!payment || payment.orderId !== input.orderId) throw Errors.notFound("Pagamento");
    if (payment.confirmed) return payment;
    await requireOpenDrawerForCash(tx, payment.method, true);

    const [result] = await tx
      .update(orderPayments)
      .set({ confirmed: true, confirmedAt: new Date().toISOString(), confirmedBy: input.userId })
      .where(eq(orderPayments.id, input.paymentId))
      .returning();

    const all = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, input.orderId));
    if (all.length > 0 && all.every((p) => p.confirmed)) {
      await tx
        .update(orders)
        .set({ paymentConfirmedAt: new Date().toISOString(), paymentConfirmedBy: input.userId })
        .where(eq(orders.id, input.orderId));
    }

    await logAction(tx, input.userId, "payment_confirmed", input.orderId, { paymentId: input.paymentId, method: payment.method });
    await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.payment_changed", {
      orderId: input.orderId,
      paymentId: input.paymentId,
      confirmed: true,
    });
    await enqueueEvent(tx, "cash-drawer", "order.payment_changed", {
      orderId: input.orderId,
      paymentId: input.paymentId,
      confirmed: true,
    });
    await enqueueEvent(tx, "kitchen-display", "order.payment_changed", {
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

  await db.transaction(async (tx) => {
    const payment = await tx.query.orderPayments.findFirst({ where: eq(orderPayments.id, input.paymentId) });
    if (!payment || payment.orderId !== input.orderId) throw Errors.notFound("Pagamento");
    if (payment.confirmed) throw Errors.invalidTransition("Pagamento já confirmado não pode ser removido.");
    await tx.delete(orderPayments).where(eq(orderPayments.id, input.paymentId));
    await logAction(tx, input.userId, "payment_removed", input.orderId, { paymentId: input.paymentId, method: payment.method });
    await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.payment_changed", { orderId: input.orderId });
    await enqueueEvent(tx, "cash-drawer", "order.payment_changed", { orderId: input.orderId });
    await enqueueEvent(tx, "kitchen-display", "order.payment_changed", { orderId: input.orderId });
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

  return await db.transaction(async (tx) => {
    const total = await computeOrderTotal(tx, order);
    const created = await upsertPaymentLines(tx, order, input.userId, [
      { method: input.paymentMethod, amount: total, confirmed: input.confirmed },
    ]);
    await logAction(tx, input.userId, "payment_registered", input.orderId, {
      paymentMethod: input.paymentMethod,
      confirmed: input.confirmed,
    });
    await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.payment_changed", {
      orderId: input.orderId,
      payments: created,
    });
    await enqueueEvent(tx, "cash-drawer", "order.payment_changed", {
      orderId: input.orderId,
      payments: created,
    });
    await enqueueEvent(tx, "kitchen-display", "order.payment_changed", {
      orderId: input.orderId,
      payments: created,
    });
    return created[0];
  });
}

// ---------- PATCH /orders/:id/close ----------
export async function closeOrderUsecase(input: { orderId: string; userId: string }) {
  const closed = await db.transaction(async (tx) => {
    const order = await tx.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    const pending = await tx
      .select({ item: orderItems, productName: products.name })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(eq(orderItems.orderId, input.orderId), notInArray(orderItems.status, ["delivered", "cancelled"])));

    if (pending.length > 0) {
      throw Errors.pendingItems(
        pending.map(({ item, productName }) => ({
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
    const payments = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, input.orderId));
    if (payments.length === 0) throw Errors.paymentNotRegistered();
    if (payments.some((p) => !p.confirmed)) throw Errors.paymentNotConfirmed();

    const total = await computeOrderTotal(tx, order);
    const paid = round2(payments.reduce((acc, p) => acc + p.amount, 0));
    if (!moneyEq(paid, total)) throw Errors.invalidPaymentTotal();

    const [result] = await tx
      .update(orders)
      .set({ status: "closed", closedAt: new Date().toISOString() })
      .where(eq(orders.id, input.orderId))
      .returning();

    if (order.tableId) {
      await tx.update(restaurantTables).set({ status: "free" }).where(eq(restaurantTables.id, order.tableId));
      await enqueueEvent(tx, `table:${order.tableId}`, "table.status_changed", {
        tableId: order.tableId,
        status: "free",
      });
    }

    await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.closed", {
      orderId: order.id,
      tableId: order.tableId,
    });
    // 1.2 — comanda fechada em outro terminal deve sumir da lista do garçom
    // (useOrders assina "kitchen-display" e remove a comanda ao receber isso).
    await enqueueEvent(tx, "kitchen-display", "order.closed", {
      orderId: order.id,
      tableId: order.tableId,
    });

    await logAction(tx, input.userId, "order_closed", input.orderId, {
      payments: payments.map(serializePayment),
    });
    return result;
  });

  cache.invalidatePattern("reports:sales:*");
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
  const cancelled = await db.transaction(async (tx) => {
    const order = await tx.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    // Estorno: dinheiro confirmado entrou na gaveta na confirmação; cancelar
    // a venda devolve esse dinheiro. A reversão vira uma sangria automática
    // no caixa corrente (`ref_order_id` para rastrear), e — coerente com o
    // bloqueio de dinheiro sem caixa — exige sessão aberta. A linha de
    // pagamento permanece confirmada: os relatórios mostram a venda e a
    // sangria de reversão, efeito líquido zero.
    const cashPaid = await tx
      .select()
      .from(orderPayments)
      .where(
        and(
          eq(orderPayments.orderId, input.orderId),
          eq(orderPayments.method, "cash"),
          eq(orderPayments.confirmed, true)
        )
      );
    const refund = round2(cashPaid.reduce((acc, p) => acc + p.amount, 0));
    if (refund > 0) {
      const drawer = await findOpenDrawerTx(tx);
      if (!drawer) throw Errors.cashRefundRequiresOpenDrawer();
      const [movement] = await tx
        .insert(cashDrawerMovements)
        .values({
          drawerId: drawer.id,
          type: "sangria",
          amount: refund,
          note: `Estorno comanda ${order.tabLabel ?? order.id}`,
          refOrderId: input.orderId,
          createdBy: input.userId,
        })
        .returning();
      await logAction(tx, input.userId, "cash_drawer_sangria", input.orderId, {
        movementId: movement.id,
        drawerId: drawer.id,
        amount: movement.amount,
        reason: input.reason,
      });
      await enqueueEvent(tx, "cash-drawer", "cash_drawer.sangria", {
        drawerId: drawer.id,
        amount: movement.amount,
        refOrderId: input.orderId,
      });
    }

    await tx
      .update(orderItems)
      .set({ status: "cancelled" })
      .where(and(eq(orderItems.orderId, input.orderId), notInArray(orderItems.status, ["delivered", "cancelled"])));

    // Estorno de estoque da comanda inteira: todo item que consumiu stock
    // (movimento 'sale' com order_id) devolve o volume como 'refund'. Itens
    // entregues também são estornados aqui — o consumo já aconteceu no
    // lançamento, e a venda não se concretizou. Sempre baseado no ledger.
    const sales = await tx
      .select({ productId: stockMovements.productId, orderItemId: stockMovements.orderItemId, quantityDelta: stockMovements.quantityDelta })
      .from(stockMovements)
      .where(and(eq(stockMovements.orderId, input.orderId), eq(stockMovements.type, "sale")));
    for (const sale of sales) {
      await applyStockMovementTx(tx, {
        productId: sale.productId,
        type: "refund",
        quantityDelta: -sale.quantityDelta,
        orderId: input.orderId,
        orderItemId: sale.orderItemId,
        note: "Comanda cancelada",
        createdBy: input.userId,
      });
    }

    const [result] = await tx
      .update(orders)
      .set({ status: "cancelled", closedAt: new Date().toISOString(), cancelReason: input.reason })
      .where(eq(orders.id, input.orderId))
      .returning();

    if (order.tableId) {
      await tx.update(restaurantTables).set({ status: "free" }).where(eq(restaurantTables.id, order.tableId));
      await enqueueEvent(tx, `table:${order.tableId}`, "table.status_changed", {
        tableId: order.tableId,
        status: "free",
      });
    }

    await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.cancelled", {
      orderId: order.id,
      tableId: order.tableId,
    });
    await enqueueEvent(tx, "kitchen-display", "order.cancelled", {
      orderId: order.id,
      tableId: order.tableId,
    });

    // Propagação do cancelamento pra entrega: comanda cancelada não pode
    // deixar a entrega órfã (awaiting/out_for_delivery pra sempre no painel
    // do entregador, cliente em "Pedido recebido" eterno — inconsistência
    // que o caminho iFood já resolvia, ver status-pushback.ts). Mesma
    // transação da escrita de domínio (AGENTS.md). "delivered" não muda —
    // comanda com entrega concluída está fechada e nunca chega aqui
    // (orderNotOpen).
    const delivery = await tx.query.deliveries.findFirst({ where: eq(deliveries.orderId, input.orderId) });
    if (delivery && delivery.status !== "delivered" && canTransitionDelivery(delivery.status, "cancelled")) {
      await tx.update(deliveries).set({ status: "cancelled" }).where(eq(deliveries.id, delivery.id));
      await enqueueEvent(tx, "deliveries", "delivery.status_changed", {
        id: delivery.id,
        orderId: input.orderId,
        courierId: delivery.courierId,
        address: delivery.address,
        status: "cancelled",
        dispatchedAt: delivery.dispatchedAt,
        deliveredAt: delivery.deliveredAt,
        notes: delivery.notes,
      });
      await emitCustomerStageChangedTx(tx, input.orderId);
    }

    await logAction(tx, input.userId, "order_cancelled", input.orderId, { reason: input.reason });
    return result;
  });

  cache.invalidatePattern("reports:sales:*");
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

  if (rows.length === 0) {
    const totalRow = await db.select({ count: count() }).from(orders).where(where as any);
    return { data: [], total: totalRow[0]?.count ?? 0 };
  }

  const orderIds = rows.map((o) => o.id);

  const itemsWithProducts = await db
    .select({
      item: orderItems,
      productName: products.name,
      productImagePath: products.imagePath,
      productKitchenGroupId: products.kitchenGroupId,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, orderIds));

  const allPayments = await db.query.orderPayments.findMany({
    where: inArray(orderPayments.orderId, orderIds),
  });

  // Uma leitura em lote, não uma por comanda. A lista e o detalhe precisam
  // devolver a mesma coisa: a tela da comanda abre a partir do objeto que está
  // na lista, então se `delivery` viesse só do detalhe o endereço só apareceria
  // depois da primeira recarga.
  const allDeliveries = await db.query.deliveries.findMany({
    where: inArray(deliveries.orderId, orderIds),
  });

  const tableIds = [...new Set(rows.map((o) => o.tableId).filter(Boolean))] as string[];
  const customerIds = [...new Set(rows.map((o) => o.customerId).filter(Boolean))] as string[];

  const tables: (typeof restaurantTables.$inferSelect)[] = tableIds.length > 0
    ? await db.query.restaurantTables.findMany({ where: inArray(restaurantTables.id, tableIds) })
    : [];
  const customerRows: (typeof customers.$inferSelect)[] = customerIds.length > 0
    ? await db.query.customers.findMany({ where: inArray(customers.id, customerIds) })
    : [];

  const tableMap = new Map(tables.map((t) => [t.id, t]));
  const customerMap = new Map(customerRows.map((c) => [c.id, c]));

  const itemsByOrder = new Map<string, typeof itemsWithProducts>();
  for (const row of itemsWithProducts) {
    const list = itemsByOrder.get(row.item.orderId) ?? [];
    list.push(row);
    itemsByOrder.set(row.item.orderId, list);
  }

  const paymentsByOrder = new Map<string, typeof allPayments>();
  for (const p of allPayments) {
    const list = paymentsByOrder.get(p.orderId) ?? [];
    list.push(p);
    paymentsByOrder.set(p.orderId, list);
  }

  const deliveryByOrderId = new Map(allDeliveries.map((d) => [d.orderId, d]));
  const deliveryOf = (orderId: string) => {
    const d = deliveryByOrderId.get(orderId);
    return d ? serializeDelivery(d) : null;
  };

  const data = rows.map((order) => ({
    id: order.id,
    status: order.status,
    tableId: order.tableId,
    tableNumber: order.tableId ? tableMap.get(order.tableId)?.number ?? null : null,
    customerId: order.customerId,
    customerName: order.customerId ? customerMap.get(order.customerId)?.name ?? null : null,
    customerPhone: order.customerId ? customerMap.get(order.customerId)?.phone ?? null : null,
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
    delivery: deliveryOf(order.id),
    items: (itemsByOrder.get(order.id) ?? []).map(
      ({ item, productName, productImagePath, productKitchenGroupId }) =>
        serializeItem(item, {
          name: productName,
          imagePath: productImagePath,
          kitchenGroupId: productKitchenGroupId,
        })
    ),
    payments: (paymentsByOrder.get(order.id) ?? []).map(serializePayment),
  }));

  const totalRow = await db.select({ count: count() }).from(orders).where(where as any);
  return { data, total: totalRow[0]?.count ?? data.length };
}

export async function listTablesUsecase() {
  return db.query.restaurantTables.findMany({ orderBy: (t, { asc }) => asc(t.number) });
}
