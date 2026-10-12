// Hub de pedidos — ONDA 2 da refatoração arquitetural.
//
// Este arquivo é uma FACTORY pura (`createOrderUsecases(deps)`): nenhuma
// importação de infra/integrations/Drizzle. Toda persistência/efeito
// transacional passa pelos ports do `TenantSession` (Unit-of-Worker), e os
// efeitos pós-commit (impressão, WhatsApp, cache de relatórios) chegam via
// deps injetadas. A composition root que liga adapters concretos é
// `src/infra/composition/default-usecases.ts`.
//
// NOTA IMPORTANTE sobre async (leia antes de tocar em qualquer transação):
// O banco oficial é Postgres, e o driver node-postgres é assíncrono de
// verdade. `uow.run(tenant, work)` entrega à `work` um `TenantSession` cujo
// repositório é SEMPRE uma Promise, então dentro da transação tudo é `await`:
//
//   await deps.uow.run(deps.tenant(), async (session) => {
//     const row = await session.orders.open({...});
//     await session.audit.record({...});
//   });
//
// Esquecer um `await` dentro da transação é o erro perigoso desta camada: o
// INSERT pode ser emitido depois do COMMIT e a escrita se perder
// silenciosamente, então todo acesso dentro do `session` precisa de `await`.
//
// O `throw` continua sendo o mecanismo de rollback (a transação aborta e o
// erro propaga), então os AppError de domínio seguem funcionando igual.
//
// APROXIMAÇÃO DE JANELA (documentada de propósito): leituras que hoje rodam
// "fora do tx" (pedido, settings, itens) agora rodam DENTRO do `uow.run` —
// uma única janela transacional por use case. Sob READ COMMITTED o resultado
// é o mesmo (snapshot por statement); o ganho é um caminho só para ler e
// escrever, sem meio-commit.
import { Errors } from "../../domain/errors.js";
import { round2, moneyEq } from "../../domain/money.js";
import { canTransitionDelivery } from "../../domain/customer-order-state.js";
import type { TenantSession, TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { CustomerNotifier, OrderPrinter, StoreSettingsReader, TenantCache } from "../ports/effects.js";
import type {
  DeliveryRecord,
  OrderItemRow,
  OrderItemWithProduct,
  OrderPaymentLineRow,
  OrderRow,
} from "../ports/repositories.js";
import { emitCustomerStageChanged } from "../self-service/customer-stage.js";
import { applyStockMovement, INVENTORY_ROOM } from "../stock/stock.usecases.js";
import { createAlert, describeOrderAlert, ORDER_ALERT_KIND, ORDER_ALERT_AUDIENCE } from "../alert/alert.usecases.js";

// Refs do produto no item: nome + foto + grupo de produção. A foto entra no
// próprio item pra tela da cozinha não precisar resolver listProducts inteiro
// (faz o caminho inverso: cozinha consome o que já veio na listagem de órden).
function serializeItem(
  it: OrderItemRow,
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

function serializeItemWithRefs(it: OrderItemWithProduct) {
  return serializeItem(it, {
    name: it.productName,
    imagePath: it.productImagePath,
    kitchenGroupId: it.productKitchenGroupId,
  });
}

function serializePayment(p: OrderPaymentLineRow) {
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
function serializeDelivery(d: DeliveryRecord) {
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

async function serializeOrder(session: TenantSession, orderId: string) {
  const order = await session.orders.findRow(orderId);
  if (!order) throw Errors.notFound("Comanda");
  const items = await session.orders.listItemsWithProduct(orderId);

  const table = order.tableId ? await session.catalog.findTable(order.tableId) : null;
  const customer = order.customerId ? await session.customers.findById(order.customerId) : null;
  const payments = await session.orders.listPaymentLines(orderId);
  const delivery = await session.deliveries.findByOrder(orderId);

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
    notes: order.notes ?? null,
    paymentMethod: order.paymentMethod,
    paymentConfirmedAt: order.paymentConfirmedAt,
    paymentConfirmedBy: order.paymentConfirmedBy,
    openedAt: order.openedAt,
    closedAt: order.closedAt,
    delivery: delivery ? serializeDelivery(delivery) : null,
    items: items.map(serializeItemWithRefs),
    payments: payments.map(serializePayment),
  };
}

// Total da comanda a partir do snapshot unit_price (nunca o preço atual do
// produto), arredondado pra 2 casas. Itens "cancelled" não contam (mesma
// regra do relatório de vendas).
//
// A versão para um `tx` Drizzle puro (consumida por application/payment) está
// em `infra/composition/order-compat.ts` — é a MESMA fórmula, e a cobrança do
// gateway continua batendo com o fechamento porque os dois leem o mesmo
// snapshot de `order_item`.
async function computeOrderTotalInSession(session: TenantSession, order: OrderRow): Promise<number> {
  const rows = await session.orders.listItemRows(order.id);
  const sum = rows
    .filter((r) => r.status !== "cancelled")
    .reduce((acc, r) => acc + r.unitPrice * r.quantity, 0);
  return round2(sum + (order.deliveryFee ?? 0));
}

// ---------- POST /orders ----------
export async function openOrderUsecase(
  deps: OrderUsecasesDeps,
  input: {
    waiterId: string;
    tableId?: string;
    customerId?: string;
    tabLabel?: string;
    channel?: "balcao" | "whatsapp" | "web" | "ifood"; // default "balcao" — self-service (§04) e iFood usam
    deliveryFee?: number; // snapshot da taxa no momento do pedido, só para channel != "balcao"
    externalRef?: string; // order id do iFood quando channel === "ifood" (único — índice em 0009)
    notes?: string;
  },
): Promise<Awaited<ReturnType<typeof serializeOrder>>> {
  if (!input.tableId && !input.customerId && !input.tabLabel) {
    throw Errors.identificationRequired();
  }

  return deps.uow.run(deps.tenant(), async (session) => {
    // 1.6 — valida a mesa antes de abrir: inexistente → 404; ocupada → 409.
    // Só vale para abertura física de comanda (channel default "balcao");
    // self-service e iFood não parametrizam mesa.
    //
    // No Postgres o "ler status e depois gravar" NÃO é atômico. Por isso a
    // ocupação é um UPDATE condicional: o `status = 'free'` é reavaliado sob o
    // lock de linha, então só uma transação consegue mudar free -> occupied.
    if (input.tableId) {
      const claimed = await session.catalog.tryClaimTable(input.tableId);
      if (!claimed) {
        // Nenhuma linha alterada: ou a mesa não existe, ou já está ocupada.
        // Uma leitura só aqui (o caminho feliz não paga essa query) decide
        // entre 404 e 409 sem reintroduzir a corrida.
        const table = await session.catalog.findTable(input.tableId);
        if (!table) throw Errors.tableNotFound(input.tableId);
        throw Errors.tableOccupied();
      }
    }

    const created = await session.orders.open({
      waiterId: input.waiterId,
      tableId: input.tableId ?? null,
      customerId: input.customerId ?? null,
      tabLabel: input.tabLabel ?? null,
      channel: input.channel ?? "balcao",
      deliveryFee: input.deliveryFee ?? null,
      externalRef: input.externalRef ?? null,
      notes: input.notes ?? null,
    });

    if (input.tableId) {
      await session.outbox.enqueue({
        room: `table:${input.tableId}`,
        type: "table.status_changed",
        aggregateId: input.tableId,
        payload: { tableId: input.tableId, status: "occupied" },
      });
    }

    await session.audit.record({
      actorId: input.waiterId,
      action: "order_opened",
      orderId: created.id,
      // Chaves ausentes no input são omitidas EXATAMENTE como o
      // JSON.stringify do `logAction` antigo omitia (undefined some, null fica).
      details: {
        ...(input.tableId !== undefined ? { tableId: input.tableId } : {}),
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        ...(input.tabLabel !== undefined ? { tabLabel: input.tabLabel } : {}),
      },
    });

    // Alerta do sino (baseline 0001). Fica AQUI, e não em cada canal, porque todos os
    // quatro passam por esta função: balcão (`POST /orders`), self-service
    // (order-intake), iFood (ingest) e qualquer canal novo. Se ficasse em cada
    // chamador, um canal novo nasceria mudo.
    //
    // O texto precisa do número da mesa / nome do cliente, que a linha do
    // pedido não traz (só os ids) — por isso as duas leituras abaixo. São
    // leituras por PK dentro de uma transação que já fez UPDATE condicional +
    // INSERT + audit, então o custo é desprezível e o ganho (alerta legível
    // "Nova comanda · Mesa 3") é todo para quem lê.
    const channel = input.channel ?? "balcao";
    const [table, customer] = await Promise.all([
      input.tableId ? session.catalog.findTable(input.tableId) : null,
      input.customerId ? session.customers.findById(input.customerId) : null,
    ]);
    const { title, body } = describeOrderAlert({
      channel,
      // Para mesa, o rótulo é o número da pessoa — um id de mesa no alerta
      // seria inútil. Sem mesa (pub/cliente), o tabLabel é o rótulo de verdade.
      label: input.tableId ? (table?.number ? `Mesa ${table.number}` : "Mesa") : input.tabLabel,
      customerName: customer?.name,
    });
    await createAlert(session, {
      kind: ORDER_ALERT_KIND,
      title,
      body,
      orderId: created.id,
      channel,
      audience: ORDER_ALERT_AUDIENCE,
    });

    return serializeOrder(session, created.id);
  });
}

// ---------- POST /orders/:id/items ----------
export async function addItemsUsecase(
  deps: OrderUsecasesDeps,
  input: {
    orderId: string;
    userId: string;
    items: Array<{
      productId: string;
      quantity: number;
      selectedVariations?: Record<string, string | string[]>;
      notes?: string;
    }>;
  },
) {
  const result = await deps.uow.run(deps.tenant(), async (session) => {
    const order = await session.orders.findRow(input.orderId);
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    const settings = await deps.settings.get();

    const createdItems: ReturnType<typeof serializeItem>[] = [];
    for (const line of input.items) {
      const product = await session.catalog.findProductForOrdering(line.productId);
      if (!product || !product.active) {
        throw Errors.validationFailed({ productId: line.productId, reason: "inativo ou inexistente" });
      }
      // Estoque (003/0016): com a feature global ligada E produto rastreando,
      // o saldo do ledger é o teto — lançar mais que disponível bloqueia a
      // comanda inteira (a transação inteira faz rollback no throw). Requer
      // saldo do ledger, nunca coluna cacheada.
      const deductsStock = settings.inventoryEnabled && product.trackStock;
      if (deductsStock) {
        const available = await session.stock.balance(product.id);
        if (available < line.quantity) throw Errors.insufficientStock(product.id, product.name, available);
      }
      // Status de entrada por estação/modo (§7.2, kitchen_enabled):
      // - sem cozinha (pub): item já entra entregue — a comanda não controla
      //   preparo/entrega e não exige confirmação do garçom;
      // - com cozinha + grupo de produção: entra na fila da estação (ordered);
      // - com cozinha sem grupo (bar/copa): entra pronto (ready) — só falta entregar.
      const hasStation = settings.kitchenEnabled && Boolean(product.kitchenGroupId);
      const initialStatus = !settings.kitchenEnabled ? "delivered" : hasStation ? "ordered" : "ready";
      const created = await session.orders.insertItem({
        orderId: input.orderId,
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: product.price, // snapshot — nunca referência viva
        // Snapshot do custo no lançamento (margem): com a feature global e
        // compras ligadas, usa a média móvel do ledger naquele instante;
        // senão, o cost_price manual do cadastro (comportamento 0016).
        costPrice:
          settings.inventoryEnabled && settings.purchaseEnabled && product.trackStock
            ? (await session.stock.movingAverage(product.id, product.costPrice)).avg
            : product.costPrice,
        selectedVariations: JSON.stringify(line.selectedVariations ?? {}),
        notes: line.notes ?? null,
        createdBy: input.userId,
        status: initialStatus,
      });
      const serialized = serializeItem(created, {
        name: product.name,
        imagePath: product.imagePath,
        kitchenGroupId: product.kitchenGroupId,
      });
      createdItems.push(serialized);

      // Débito do estoque no mesmo commit do item (rollback garante que item
      // e saldo nunca divergam). Eventos stock.movement/stock.low vão pro
      // room "inventory" — quem assina (aba Estoque do gerente) atualiza.
      if (deductsStock) {
        const { balance } = await applyStockMovement(session, {
          productId: product.id,
          type: "sale",
          quantityDelta: -line.quantity,
          orderId: input.orderId,
          orderItemId: created.id,
          createdBy: input.userId,
        });
        if (product.trackStock && product.lowStockThreshold > 0 && balance <= product.lowStockThreshold) {
          await session.outbox.enqueue({
            room: INVENTORY_ROOM,
            type: "stock.low",
            aggregateId: product.id,
            payload: {
              productId: product.id,
              name: product.name,
              quantity: balance,
              threshold: product.lowStockThreshold,
            },
          });
        }
      }

      await session.outbox.enqueue({
        room: `table:${order.tableId ?? order.id}`,
        type: "order.item.created",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, item: serialized },
      });
      // Roteamento por estação: só entra na fila da cozinha quando há cozinha
      // E o produto tem grupo de produção. Bar/copa e modo pub não emitem.
      if (hasStation) {
        await session.outbox.enqueue({
          room: "kitchen-display",
          type: "order.item.created",
          aggregateId: input.orderId,
          payload: { orderId: input.orderId, item: serialized },
        });
      }
    }

    await session.audit.record({
      actorId: input.userId,
      action: "item_added",
      orderId: input.orderId,
      details: { items: createdItems },
    });
    return { createdItems, settings };
  });

  // Impressão automática da cozinha (pós-commit, fire-and-forget): só quando
  // as duas flags estão ligadas E o modo cozinha está ativo. O daemon tem
  // fila de retry própria; falha aqui nunca quebra o lançamento.
  if (result.settings.printerEnabled && result.settings.printerAutoPrint && result.settings.kitchenEnabled) {
    deps.printer.printKitchenOrder(input.orderId).catch((err) => console.error("falha ao imprimir comanda na cozinha:", err));
  }

  return result.createdItems;
}

// ---------- PATCH /orders/:id/items/:itemId ----------
export async function updateItemStatusUsecase(
  deps: OrderUsecasesDeps,
  input: {
    orderId: string;
    itemId: string;
    userId: string;
    userRole: "waiter" | "kitchen" | "manager" | "courier" | "cashier";
    newStatus: "ready" | "delivered";
    expectedVersion: number;
  },
) {
  // Último item pronto do pedido self-service muda o stage (preparing →
  // ready) e notifica o cliente no WhatsApp — a página pública e o bot
  // consomem o evento customer.stage_changed (room order:<orderId>).
  const { updated, readyNotifyOrderId } = await deps.uow.run(deps.tenant(), async (session) => {
    const item = await session.orders.findItem(input.itemId);
    if (!item || item.orderId !== input.orderId) throw Errors.notFound("Item");
    const settings = await deps.settings.get();

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

    let readyNotify: string | null = null;
    const result = await session.orders.transitionItemStatus(input.itemId, input.newStatus, input.expectedVersion);
    if (!result) {
      const current = await session.orders.findItem(input.itemId);
      throw Errors.concurrencyConflict(current?.version ?? -1);
    }

    const parentOrder = await session.orders.findRow(input.orderId);
    await session.outbox.enqueue({
      room: `table:${parentOrder?.tableId ?? input.orderId}`,
      type: "order.item.status_changed",
      aggregateId: input.orderId,
      payload: {
        orderId: input.orderId,
        itemId: input.itemId,
        status: input.newStatus,
        changedBy: input.userId,
      },
    });
    await session.outbox.enqueue({
      room: "kitchen-display",
      type: "order.item.status_changed",
      aggregateId: input.orderId,
      payload: {
        orderId: input.orderId,
        itemId: input.itemId,
        status: input.newStatus,
        changedBy: input.userId,
      },
    });

    // Só pra comanda de delivery (whatsapp/web) — comanda de mesa não tem
    // máquina de cliente (nobody assina order:<orderId> de mesa). O stage
    // só muda de fato quando o ÚLTIMO item ativo fica pronto.
    const isSelfService = parentOrder?.channel === "whatsapp" || parentOrder?.channel === "web";
    if (isSelfService && input.newStatus === "ready") {
      const allItems = await session.orders.listItemRows(input.orderId);
      const activeItems = allItems.filter((i) => i.status !== "cancelled");
      if (activeItems.length > 0 && activeItems.every((i) => i.status === "ready" || i.status === "delivered")) {
        await emitCustomerStageChanged(session, input.orderId);
        readyNotify = input.orderId;
      }
    }

    const action = input.newStatus === "delivered" ? "item_delivered" : "item_ready";
    await session.audit.record({
      actorId: input.userId,
      action,
      orderId: input.orderId,
      details: { itemId: input.itemId },
    });

    return { updated: result, readyNotifyOrderId: readyNotify };
  });

  if (readyNotifyOrderId) {
    deps.notifier.notifyReady(readyNotifyOrderId).catch((err) => console.error("falha ao notificar pedido pronto pro cliente:", err));
  }

  return { ...updated, selectedVariations: JSON.parse(updated.selectedVariations) };
}

// ---------- DELETE /orders/:id/items/:itemId ----------
export async function deleteItemUsecase(
  deps: OrderUsecasesDeps,
  input: {
    orderId: string;
    itemId: string;
    userId: string;
  },
) {
  await deps.uow.run(deps.tenant(), async (session) => {
    const item = await session.orders.findItem(input.itemId);
    if (!item || item.orderId !== input.orderId) throw Errors.notFound("Item");
    const settings = await deps.settings.get();
    // Modo sem cozinha: a comanda não controla status — item já entra entregue,
    // então exclusão por engano continua permitida. Com cozinha, item entregue é imutável.
    if (settings.kitchenEnabled && item.status === "delivered") throw Errors.itemAlreadyDelivered();

    // Estorno de estoque: se o item consumiu stock no lançamento (movimento
    // 'sale' vinculado ao item existe), devolve o mesmo volume como 'refund'.
    // Baseado no ledger (e não no flag atual do produto) — a decisão de
    // repor é "houve consumo", então o ledger continua consistente mesmo se
    // o produto deixou de rastrear estoque depois.
    const sales = await session.stock.listSalesMovementsForItem(input.itemId);
    for (const sale of sales) {
      await applyStockMovement(session, {
        productId: item.productId,
        type: "refund",
        quantityDelta: -sale.quantityDelta, // sale é negativo → refund positivo
        orderId: input.orderId,
        orderItemId: input.itemId,
        note: "Item removido",
        createdBy: input.userId,
      });
    }

    await session.orders.deleteItem(input.itemId);
    await session.audit.record({
      actorId: input.userId,
      action: "item_removed",
      orderId: input.orderId,
      details: { itemId: input.itemId, name: item.productId },
    });
    // 1.8 — item removido em um terminal precisa sumir dos demais (garçom/gerente
    // assinam "kitchen-display"; "table:{id}" não é assinado por ninguém).
    await session.outbox.enqueue({
      room: `table:${item.orderId}`,
      type: "order.item.removed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, itemId: input.itemId },
    });
    await session.outbox.enqueue({
      room: "kitchen-display",
      type: "order.item.removed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, itemId: input.itemId },
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
//
// FOR UPDATE: quando o pagamento é dinheiro confirmado, travamos a linha do
// drawer para evitar que duas transações concorrentes ambas leiam o drawer
// como aberto e insiram pagamentos que, somados, excedam o saldo disponível.
// O lock serializa o acesso à linha aberta dentro da transação.
async function requireOpenDrawerForCash(session: TenantSession, method: string, confirmed: boolean) {
  if (method === "cash" && confirmed && !(await session.cashFlow.findOpenForUpdate())) {
    throw Errors.paymentRequiresOpenDrawer();
  }
}

// Rótulo em PT-BR das formas de pagamento, só para a mensagem de recusa (no
// payload o backend continua falando "cash"/"card"/"pix"/"other").
const PAYMENT_LABEL: Record<PaymentLineInput["method"], string> = {
  cash: "Dinheiro",
  card: "Cartão",
  pix: "Pix",
  other: "Outro",
};

// Aplica as linhas de pagamento na mesma transação da escrita (padrão do repo),
// a partir do plano já validado por `planPaymentLines`.
//
// Uma linha JÁ CONFIRMADA é dinheiro que já se mexeu, e o PUT não pode mais
// simplesmente "apagar tudo e reinserir":
//
//   - a gaveta não tem saldo próprio. `GET /cash-drawer/*` conta
//     `order_payment` com `method='cash' AND confirmed` na janela da sessão
//     (cash-flow.usecases.ts → cashPaymentsBetween) — apagar a linha tira o
//     dinheiro do relatório *retroativamente*, sem sangra, sem movimento de
//     estorno e sem rastro em auditoria, já que o dinheiro foi pro bolso do
//     garçom;
//   - o relatório de vendas soma toda linha de `order_payment` por forma
//     (report.usecases.ts), então cartão/pix confirmados também não podem
//     sumir em silêncio — por isso a guarda vale pra todos os métodos, e não
//     só pra `cash`;
//   - `DELETE /orders/:id/payments/:paymentId` já recusava linha confirmada
//     (invalidTransition). Seria incoerente (e pior) o PUT em lote conseguir
//     apagar o que o DELETE nega.
//
// Então o PUT deixou de ser destrutivo e passou a ter 3 casos, nesta ordem:
//
//   1. PRESERVA a linha confirmada que continua na lista com mesmo método e
//      mesmo valor (só `received`/`change` podem mudar). Mantém id,
//      `confirmed_at` e `confirmed_by` — a identidade do dinheiro que a gaveta
//      reconcilia. É o que torna o PUT repetível sem efeito colateral.
//   2. RECUSA a linha confirmada que some da lista. O estorno é explícito e
//      registrado (cancelamento da comanda, que gera a sangria, ou sangria no
//      caixa) — nunca implícito num reenvio.
//   3. Linhas não confirmadas continuam sendo reescritas livremente: não há
//      dinheiro envolvido.
//
// `orders.payment_method` continua como denormalizado de exibição — método
// único → ele; mais de um → null (o client consome `payments[]` pra exibir o
// detalhe).
//
// Fases separadas de propósito: `planPaymentLines` só LÊ e valida, e
// `upsertPaymentLines` só ESCREVE. O chamador roda a fase de leitura ANTES da
// conferência `soma == total`: se o request deixou de fora uma linha
// confirmada, a resposta honesta é "isso exige estorno", e não "a soma não
// confere" — que mandaria o usuário corrigir um número que está certo.
type PaymentPlan = {
  /** Linhas confirmadas mantidas: a linha da nova lista que casa com cada uma. */
  preserved: Array<{ row: OrderPaymentLineRow; line: PaymentLineInput }>;
  /** Índices de `lines` que casaram com uma confirmada (não reinserir). */
  matched: Set<number>;
  /** Ids que saem da tabela — só as não confirmadas que sobraram. */
  dropIds: string[];
};

/**
 * Lê as linhas de pagamento atuais e decide o que acontece com cada uma.
 * Recusa (invalid_transition) qualquer linha já CONFIRMADA que a nova lista
 * deixou de fora. Não escreve nada.
 */
async function planPaymentLines(
  session: TenantSession,
  order: OrderRow,
  lines: PaymentLineInput[],
): Promise<PaymentPlan> {
  // Leitura ANTES do delete, na mesma transação: a guarda precisa enxergar as
  // linhas confirmadas que o request deixou de fora.
  const existing = await session.orders.listPaymentLines(order.id);

  // Casa 1:1 cada confirmada existente com uma linha da nova lista (mesmo
  // método + mesmo valor). `matched` impede que uma linha da nova lista
  // "adote" duas confirmadas — no dinheiro seria o caminho pra preservar uma e
  // deixar a outra sem par (e, portanto, recusada).
  const matched = new Set<number>();
  const preserved: PaymentPlan["preserved"] = [];
  for (const current of existing) {
    if (!current.confirmed) continue; // não confirmada é reescrita à vontade
    const idx = lines.findIndex(
      (l, i) => !matched.has(i) && l.method === current.method && moneyEq(l.amount, current.amount)
    );
    if (idx === -1) {
      throw Errors.invalidTransition(
        `Pagamento já confirmado (${PAYMENT_LABEL[current.method]} de R$ ${current.amount.toFixed(2)}) não pode sair da lista: o estorno precisa ser explícito. Reenvie mantendo a linha ou estorne pelo fluxo de caixa.`
      );
    }
    matched.add(idx);
    preserved.push({ row: current, line: lines[idx] });
  }

  const keptIds = new Set(preserved.map((p) => p.row.id));
  return { preserved, matched, dropIds: existing.filter((p) => !keptIds.has(p.id)).map((p) => p.id) };
}

async function upsertPaymentLines(
  session: TenantSession,
  order: OrderRow,
  userId: string,
  lines: PaymentLineInput[],
  plan: PaymentPlan
) {
  const { preserved, matched } = plan;

  // A fase de leitura já recusou qualquer linha confirmada fora da lista, e a
  // transação aborta por `throw` — então aqui o delete só alcança as não
  // confirmadas que sobraram, e nunca uma linha preservada.
  if (plan.dropIds.length > 0) {
    await session.orders.deletePaymentLines(plan.dropIds);
  }

  const rows: OrderPaymentLineRow[] = [];

  for (const { row, line } of preserved) {
    // A linha preservada fica CONFIRMADA mesmo que o request mande
    // `confirmed: false`: o dinheiro já está na gaveta, e desconfirmar aqui
    // seria a mesma sangra do caso 2 por outro nome. Só o troco pode mudar.
    // `requireOpenDrawerForCash` também não roda: a guarda foi cumprida na
    // confirmação original e aqui não entra dinheiro novo — cobrá-la de novo
    // quebraria justamente a repetição segura que o caso 1 promete.
    const isCash = line.method === "cash";
    const received = isCash ? (line.received != null ? line.received : line.amount) : null;
    if (isCash && received != null && received < line.amount) {
      throw Errors.validationFailed({ field: "received", reason: "dinheiro recebido menor que o valor a pagar" });
    }
    const change = isCash && received != null ? round2(received - line.amount) : null;
    if ((received == null) === (row.received == null) && moneyEq(received ?? 0, row.received ?? 0) && moneyEq(change ?? 0, row.change ?? 0)) {
      rows.push(row); // nada mudou: não reescreve (preserva created_at)
      continue;
    }
    const updated = await session.orders.updatePaymentLineReceived(row.id, { received, change });
    rows.push(updated);
  }

  for (let i = 0; i < lines.length; i++) {
    if (matched.has(i)) continue; // já preservada acima
    const line = lines[i];
    await requireOpenDrawerForCash(session, line.method, Boolean(line.confirmed));
    const isCash = line.method === "cash";
    const confirmed = Boolean(line.confirmed);
    const received = isCash ? (line.received != null ? line.received : line.amount) : null;
    if (isCash && confirmed && received != null && received < line.amount) {
      throw Errors.validationFailed({ field: "received", reason: "dinheiro recebido menor que o valor a pagar" });
    }
    const change = isCash && received != null ? round2(received - line.amount) : null;
    const row = await session.orders.insertPaymentLine({
      orderId: order.id,
      method: line.method,
      amount: round2(line.amount),
      received,
      change,
      confirmed,
      confirmedAt: confirmed ? new Date().toISOString() : null,
      confirmedBy: confirmed ? userId : null,
      createdBy: userId,
    });
    rows.push(row);
  }

  const methods = [...new Set(rows.map((r) => r.method))];
  const allConfirmed = rows.length > 0 && rows.every((r) => r.confirmed);
  await session.orders.updatePaymentSummary(order.id, {
    paymentMethod: methods.length === 1 ? methods[0] : null,
    // Um PUT que só reenvia as mesmas linhas não pode regrampar "quando a
    // comanda foi quitada" — o que a gaveta e os relatórios reconciliam é o
    // `confirmed_at` da linha de pagamento, não este denormalizado.
    paymentConfirmedAt: allConfirmed ? order.paymentConfirmedAt ?? new Date().toISOString() : null,
    paymentConfirmedBy: allConfirmed ? order.paymentConfirmedBy ?? userId : null,
  });

  return {
    // `payments` é o estado final da comanda (preservadas + novas) — é o que
    // viaja nos enqueueEvent, então o cash-drawer e a cozinha recebem sempre o
    // conjunto coerente, e não só o que o request mandou.
    payments: rows.map(serializePayment),
    // Auditoria: distingue o que foi reaproveitado do que é novo, senão o log
    // diria "created" para um pagamento que já estava confirmado na gaveta.
    // `rows` são as preservadas + as inseridas agora; o que sobrou é inserção.
    reused: preserved.map((p) => p.row.id),
    created: rows.filter((r) => !preserved.some((p) => p.row.id === r.id)).map((r) => r.id),
  };
}

export async function setOrderPaymentsUsecase(
  deps: OrderUsecasesDeps,
  input: {
    orderId: string;
    userId: string;
    payments: PaymentLineInput[];
  },
) {
  await deps.uow.run(deps.tenant(), async (session) => {
    const settings = await deps.settings.get();
    const enabled: string[] = JSON.parse(settings.enabledPaymentMethods);
    if (input.payments.length === 0) {
      throw Errors.validationFailed({ field: "payments", reason: "informe ao menos uma forma de pagamento" });
    }

    const order = await session.orders.findRow(input.orderId);
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    for (const p of input.payments) {
      if (!enabled.includes(p.method)) throw Errors.paymentMethodDisabled();
      if (!(p.amount > 0)) throw Errors.validationFailed({ field: "amount", reason: "valor deve ser maior que zero" });
    }

    // Guarda de remoção ANTES da conferência da soma (ver planPaymentLines):
    // linha confirmada fora da lista é "exige estorno", não "soma errada".
    const plan = await planPaymentLines(session, order, input.payments);
    const total = await computeOrderTotalInSession(session, order);
    const sum = round2(input.payments.reduce((acc, p) => acc + p.amount, 0));
    if (!moneyEq(sum, total)) throw Errors.invalidPaymentTotal();

    const { payments, reused, created } = await upsertPaymentLines(session, order, input.userId, input.payments, plan);
    // `reused` separa o pagamento que a gaveta já conta do que é novo: um PUT
    // que reenvia as mesmas linhas não pode aparecer no log como tudo novo.
    await session.audit.record({
      actorId: input.userId,
      action: "payment_registered",
      orderId: input.orderId,
      details: { payments, reused, created },
    });
    await session.outbox.enqueue({
      room: `table:${order.tableId ?? order.id}`,
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, payments },
    });
    await session.outbox.enqueue({
      room: "cash-drawer",
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, payments },
    });
    await session.outbox.enqueue({
      room: "kitchen-display",
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, payments },
    });
  });

  return serializeOrderOutside(deps, input.orderId);
}

export async function confirmOrderPaymentUsecase(
  deps: OrderUsecasesDeps,
  input: { orderId: string; paymentId: string; userId: string },
) {
  return deps.uow.run(deps.tenant(), async (session) => {
    const order = await session.orders.findRow(input.orderId);
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    const payment = await session.orders.findPaymentLine(input.paymentId);
    if (!payment || payment.orderId !== input.orderId) throw Errors.notFound("Pagamento");
    if (payment.confirmed) return serializePayment(payment);
    await requireOpenDrawerForCash(session, payment.method, true);

    const result = await session.orders.confirmPaymentLine(input.paymentId, {
      confirmedAt: new Date().toISOString(),
      confirmedBy: input.userId,
    });

    const all = await session.orders.listPaymentLines(input.orderId);
    if (all.length > 0 && all.every((p) => p.confirmed)) {
      await session.orders.updatePaymentSummary(input.orderId, {
        paymentConfirmedAt: new Date().toISOString(),
        paymentConfirmedBy: input.userId,
      });
    }

    await session.audit.record({
      actorId: input.userId,
      action: "payment_confirmed",
      orderId: input.orderId,
      details: { paymentId: input.paymentId, method: payment.method },
    });
    await session.outbox.enqueue({
      room: `table:${order.tableId ?? order.id}`,
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, paymentId: input.paymentId, confirmed: true },
    });
    await session.outbox.enqueue({
      room: "cash-drawer",
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, paymentId: input.paymentId, confirmed: true },
    });
    await session.outbox.enqueue({
      room: "kitchen-display",
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, paymentId: input.paymentId, confirmed: true },
    });
    return serializePayment(result);
  });
}

export async function deleteOrderPaymentUsecase(
  deps: OrderUsecasesDeps,
  input: { orderId: string; paymentId: string; userId: string },
) {
  await deps.uow.run(deps.tenant(), async (session) => {
    const order = await session.orders.findRow(input.orderId);
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    const payment = await session.orders.findPaymentLine(input.paymentId);
    if (!payment || payment.orderId !== input.orderId) throw Errors.notFound("Pagamento");
    if (payment.confirmed) throw Errors.invalidTransition("Pagamento já confirmado não pode ser removido.");
    await session.orders.deletePaymentLine(input.paymentId);
    await session.audit.record({
      actorId: input.userId,
      action: "payment_removed",
      orderId: input.orderId,
      details: { paymentId: input.paymentId, method: payment.method },
    });
    await session.outbox.enqueue({
      room: `table:${order.tableId ?? order.id}`,
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId },
    });
    await session.outbox.enqueue({
      room: "cash-drawer",
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId },
    });
    await session.outbox.enqueue({
      room: "kitchen-display",
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId },
    });
  });
}

// ---------- PATCH /orders/:id/payment (legado) ----------
// Adaptador sobre o modelo fracionado: transforma o registro antigo (método
// único, sem valor) em uma única linha de 100% do total. Mantém o fluxo
// self-service/entrega funcionando sem mudança (intenção confirmed:false no
// checkout; confirmação confirmed:true na entrega).
export async function registerPaymentUsecase(
  deps: OrderUsecasesDeps,
  input: {
    orderId: string;
    userId: string;
    paymentMethod: "cash" | "card" | "pix" | "other";
    confirmed: boolean;
    /** Só cash: quanto o cliente vai entregar. Ausente = valor exato. */
    received?: number;
  },
) {
  return deps.uow.run(deps.tenant(), async (session) => {
    const settings = await deps.settings.get();
    const enabled: string[] = JSON.parse(settings.enabledPaymentMethods);
    if (!enabled.includes(input.paymentMethod)) throw Errors.paymentMethodDisabled();

    const order = await session.orders.findRow(input.orderId);
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    const total = await computeOrderTotalInSession(session, order);
    // Intenção única de 100% do total — a mesma linha que entra por
    // planPaymentLines/upsertPaymentLines, com a mesma guarda de linha
    // confirmada (ver o comentário de upsertPaymentLines).
    const lines: PaymentLineInput[] = [
      { method: input.paymentMethod, amount: total, confirmed: input.confirmed, received: input.received },
    ];
    const { payments, reused, created } = await upsertPaymentLines(
      session,
      order,
      input.userId,
      lines,
      await planPaymentLines(session, order, lines)
    );
    await session.audit.record({
      actorId: input.userId,
      action: "payment_registered",
      orderId: input.orderId,
      details: {
        paymentMethod: input.paymentMethod,
        confirmed: input.confirmed,
        reused,
        created,
      },
    });
    await session.outbox.enqueue({
      room: `table:${order.tableId ?? order.id}`,
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, payments },
    });
    await session.outbox.enqueue({
      room: "cash-drawer",
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, payments },
    });
    await session.outbox.enqueue({
      room: "kitchen-display",
      type: "order.payment_changed",
      aggregateId: input.orderId,
      payload: { orderId: input.orderId, payments },
    });
    return payments[0];
  });
}

// ---------- PATCH /orders/:id/close ----------
export async function closeOrderUsecase(
  deps: OrderUsecasesDeps,
  input: { orderId: string; userId: string },
) {
  const closed = await deps.uow.run(deps.tenant(), async (session) => {
    const order = await session.orders.findRow(input.orderId);
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    const pending = (await session.orders.listItemsWithProduct(input.orderId)).filter(
      (it) => it.status !== "delivered" && it.status !== "cancelled"
    );
    if (pending.length > 0) {
      throw Errors.pendingItems(
        pending.map((it) => ({
          id: it.id,
          name: it.productName,
          quantity: it.quantity,
          status: it.status,
        }))
      );
    }

    // Pagamento fracionado: exige ao menos uma linha, todas confirmadas e a
    // soma conferindo com o total (evita fechar com "intenção" de Pix ainda
    // não recebida, ou com divisão que não cobre a conta).
    const payments = await session.orders.listPaymentLines(input.orderId);
    if (payments.length === 0) throw Errors.paymentNotRegistered();
    if (payments.some((p) => !p.confirmed)) throw Errors.paymentNotConfirmed();

    const total = await computeOrderTotalInSession(session, order);
    const paid = round2(payments.reduce((acc, p) => acc + p.amount, 0));
    if (!moneyEq(paid, total)) throw Errors.invalidPaymentTotal();

    const result = await session.orders.markClosed(input.orderId);

    if (order.tableId) {
      await session.catalog.releaseTable(order.tableId);
      await session.outbox.enqueue({
        room: `table:${order.tableId}`,
        type: "table.status_changed",
        aggregateId: order.tableId,
        payload: { tableId: order.tableId, status: "free" },
      });
    }

    await session.outbox.enqueue({
      room: `table:${order.tableId ?? order.id}`,
      type: "order.closed",
      aggregateId: order.id,
      payload: { orderId: order.id, tableId: order.tableId },
    });
    // 1.2 — comanda fechada em outro terminal deve sumir da lista do garçom
    // (useOrders assina "kitchen-display" e remove a comanda ao receber isso).
    await session.outbox.enqueue({
      room: "kitchen-display",
      type: "order.closed",
      aggregateId: order.id,
      payload: { orderId: order.id, tableId: order.tableId },
    });

    await session.audit.record({
      actorId: input.userId,
      action: "order_closed",
      orderId: input.orderId,
      details: { payments: payments.map(serializePayment) },
    });
    return result;
  });

  await deps.cache.invalidatePrefix("reports:sales:");
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
export async function cancelOrderUsecase(
  deps: OrderUsecasesDeps,
  input: { orderId: string; userId: string; reason: string },
) {
  const cancelled = await deps.uow.run(deps.tenant(), async (session) => {
    const order = await session.orders.findRow(input.orderId);
    if (!order) throw Errors.notFound("Comanda");
    if (order.status !== "open") throw Errors.orderNotOpen();

    // Estorno: dinheiro confirmado entrou na gaveta na confirmação; cancelar
    // a venda devolve esse dinheiro. A reversão vira uma sangria automática
    // no caixa corrente (`ref_order_id` para rastrear) e — coerente com o
    // bloqueio de dinheiro sem caixa — exige sessão aberta. A linha de
    // pagamento permanece confirmada: os relatórios mostram a venda e a
    // sangria de reversão, efeito líquido zero.
    const cashPaid = (await session.orders.listPaymentLines(input.orderId)).filter(
      (p) => p.method === "cash" && p.confirmed
    );
    const refund = round2(cashPaid.reduce((acc, p) => acc + p.amount, 0));
    if (refund > 0) {
      // FOR UPDATE: o estorno gera sangria automática que reduz o saldo do
      // caixa. Sem o lock, dois cancelamentos concorrentes poderiam ambos ler
      // o drawer como aberto e gerar sangrias que, somadas, excederiam o
      // saldo disponível. O lock serializa o acesso à linha aberta.
      const drawer = await session.cashFlow.findOpenForUpdate();
      if (!drawer) throw Errors.cashRefundRequiresOpenDrawer();
      const movement = await session.cashFlow.recordMovement({
        drawerId: drawer.id,
        actorId: input.userId,
        type: "sangria",
        amount: refund,
        note: `Estorno comanda ${order.tabLabel ?? order.id}`,
        refOrderId: input.orderId,
      });
      await session.audit.record({
        actorId: input.userId,
        action: "cash_drawer_sangria",
        orderId: input.orderId,
        details: {
          movementId: movement.id,
          drawerId: drawer.id,
          amount: movement.amount,
          reason: input.reason,
        },
      });
      await session.outbox.enqueue({
        room: "cash-drawer",
        type: "cash_drawer.sangria",
        aggregateId: drawer.id,
        payload: { drawerId: drawer.id, amount: movement.amount, refOrderId: input.orderId },
      });
    }

    await session.orders.cancelActiveItems(input.orderId);

    // Estorno de estoque da comanda inteira: todo item que consumiu stock
    // (movimento 'sale' com order_id) devolve o volume como 'refund'. Itens
    // entregues também são estornados aqui — o consumo já aconteceu no
    // lançamento, e a venda não se concretizou. Sempre baseado no ledger.
    const sales = await session.stock.listSalesMovementsForOrder(input.orderId);
    for (const sale of sales) {
      await applyStockMovement(session, {
        productId: sale.productId,
        type: "refund",
        quantityDelta: -sale.quantityDelta,
        orderId: input.orderId,
        orderItemId: sale.orderItemId,
        note: "Comanda cancelada",
        createdBy: input.userId,
      });
    }

    const result = await session.orders.markCancelled(input.orderId, input.reason);

    if (order.tableId) {
      await session.catalog.releaseTable(order.tableId);
      await session.outbox.enqueue({
        room: `table:${order.tableId}`,
        type: "table.status_changed",
        aggregateId: order.tableId,
        payload: { tableId: order.tableId, status: "free" },
      });
    }

    await session.outbox.enqueue({
      room: `table:${order.tableId ?? order.id}`,
      type: "order.cancelled",
      aggregateId: order.id,
      payload: { orderId: order.id, tableId: order.tableId },
    });
    await session.outbox.enqueue({
      room: "kitchen-display",
      type: "order.cancelled",
      aggregateId: order.id,
      payload: { orderId: order.id, tableId: order.tableId },
    });

    // Propagação do cancelamento pra entrega: comanda cancelada não pode
    // deixar a entrega órfã (awaiting/out_for_delivery pra sempre no painel
    // do entregador, cliente em "Pedido recebido" eterno — inconsistência
    // que o caminho iFood já resolvia, ver status-pushback.ts). Mesma
    // transação da escrita de domínio (AGENTS.md). "delivered" não muda —
    // comanda com entrega concluída está fechada e nunca chega aqui
    // (orderNotOpen).
    const delivery = await session.deliveries.findByOrder(input.orderId);
    if (delivery && delivery.status !== "delivered" && canTransitionDelivery(delivery.status, "cancelled")) {
      await session.deliveries.transition(delivery.id, "cancelled");
      await session.outbox.enqueue({
        room: "deliveries",
        type: "delivery.status_changed",
        aggregateId: delivery.id,
        payload: {
          id: delivery.id,
          orderId: input.orderId,
          courierId: delivery.courierId,
          address: delivery.address,
          status: "cancelled",
          dispatchedAt: delivery.dispatchedAt,
          deliveredAt: delivery.deliveredAt,
          notes: delivery.notes,
        },
      });
      await emitCustomerStageChanged(session, input.orderId);
    }

    await session.audit.record({
      actorId: input.userId,
      action: "order_cancelled",
      orderId: input.orderId,
      details: { reason: input.reason },
    });
    return result;
  });

  await deps.cache.invalidatePrefix("reports:sales:");
  return cancelled;
}

// ---------- GET /orders, GET /orders/:id, GET /tables ----------
async function serializeOrderOutside(deps: OrderUsecasesDeps, orderId: string) {
  return deps.uow.run(deps.tenant(), (session) => serializeOrder(session, orderId));
}

export async function getOrderUsecase(deps: OrderUsecasesDeps, orderId: string) {
  return serializeOrderOutside(deps, orderId);
}

export async function listOrdersUsecase(
  deps: OrderUsecasesDeps,
  input: { status?: "open" | "closed"; limit: number; offset: number },
) {
  return deps.uow.run(deps.tenant(), async (session) => {
    const page = await session.orders.listRows({
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    });
    const rows = page.data;
    if (rows.length === 0) return { data: [], total: page.total };

    const orderIds = rows.map((o) => o.id);

    const itemsWithProducts = await session.orders.listItemsWithProductForOrders(orderIds);
    const allPayments = await session.orders.listPaymentLinesForOrders(orderIds);

    // Uma leitura em lote, não uma por comanda. A lista e o detalhe precisam
    // devolver a mesma coisa: a tela da comanda abre a partir do objeto que está
    // na lista, então se `delivery` viesse só do detalhe o endereço só apareceria
    // depois da primeira recarga.
    const allDeliveries = await session.deliveries.listByOrderIds(orderIds);

    const tableIds = [...new Set(rows.map((o) => o.tableId).filter(Boolean))] as string[];
    const customerIds = [...new Set(rows.map((o) => o.customerId).filter(Boolean))] as string[];

    const tables = tableIds.length > 0 ? await session.catalog.listTablesByIds(tableIds) : [];
    const customerRows = customerIds.length > 0 ? await session.customers.findByIds(customerIds) : [];

    const tableMap = new Map(tables.map((t) => [t.id, t]));
    const customerMap = new Map(customerRows.map((c) => [c.id, c]));

    const itemsByOrder = new Map<string, OrderItemWithProduct[]>();
    for (const row of itemsWithProducts) {
      const list = itemsByOrder.get(row.orderId) ?? [];
      list.push(row);
      itemsByOrder.set(row.orderId, list);
    }

    const paymentsByOrder = new Map<string, OrderPaymentLineRow[]>();
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
      notes: order.notes ?? null,
      paymentMethod: order.paymentMethod,
      paymentConfirmedAt: order.paymentConfirmedAt,
      paymentConfirmedBy: order.paymentConfirmedBy,
      openedAt: order.openedAt,
      closedAt: order.closedAt,
      delivery: deliveryOf(order.id),
      items: (itemsByOrder.get(order.id) ?? []).map(serializeItemWithRefs),
      payments: (paymentsByOrder.get(order.id) ?? []).map(serializePayment),
    }));

    return { data, total: page.total };
  });
}

export async function listTablesUsecase(deps: OrderUsecasesDeps) {
  return deps.uow.run(deps.tenant(), (session) => session.catalog.listTables());
}

// ---------- factory ----------

/**
 * Deps da factory: Unit-of-Worker + tenant resolvido POR CHAMADA + os três
 * efeitos pós-commit/settings (impressão, WhatsApp, cache de relatórios e
 * `store_settings`). Nada de infra concreta aqui — quem instancia é a
 * composition root (`infra/composition/default-usecases.ts`).
 */
export interface OrderUsecasesDeps {
  uow: TenantUnitOfWork;
  cache: TenantCache;
  printer: OrderPrinter;
  notifier: CustomerNotifier;
  settings: StoreSettingsReader;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

/**
 * As 13 use cases do hub de pedidos, com as MESMAS assinaturas de input das
 * funções avulsas antigas (a única diferença é o `deps` primeiro). Os nomes
 * legados (`openOrderUsecase(...)` etc.) são re-exportados por
 * `infra/composition/default-usecases.ts` para os consumidores não migrados.
 */
export function createOrderUsecases(deps: OrderUsecasesDeps) {
  return {
    openOrderUsecase: (input: Parameters<typeof openOrderUsecase>[1]) => openOrderUsecase(deps, input),
    addItemsUsecase: (input: Parameters<typeof addItemsUsecase>[1]) => addItemsUsecase(deps, input),
    updateItemStatusUsecase: (input: Parameters<typeof updateItemStatusUsecase>[1]) =>
      updateItemStatusUsecase(deps, input),
    deleteItemUsecase: (input: Parameters<typeof deleteItemUsecase>[1]) => deleteItemUsecase(deps, input),
    setOrderPaymentsUsecase: (input: Parameters<typeof setOrderPaymentsUsecase>[1]) =>
      setOrderPaymentsUsecase(deps, input),
    confirmOrderPaymentUsecase: (input: Parameters<typeof confirmOrderPaymentUsecase>[1]) =>
      confirmOrderPaymentUsecase(deps, input),
    deleteOrderPaymentUsecase: (input: Parameters<typeof deleteOrderPaymentUsecase>[1]) =>
      deleteOrderPaymentUsecase(deps, input),
    registerPaymentUsecase: (input: Parameters<typeof registerPaymentUsecase>[1]) =>
      registerPaymentUsecase(deps, input),
    closeOrderUsecase: (input: Parameters<typeof closeOrderUsecase>[1]) => closeOrderUsecase(deps, input),
    cancelOrderUsecase: (input: Parameters<typeof cancelOrderUsecase>[1]) => cancelOrderUsecase(deps, input),
    getOrderUsecase: (orderId: string) => getOrderUsecase(deps, orderId),
    listOrdersUsecase: (input: Parameters<typeof listOrdersUsecase>[1]) => listOrdersUsecase(deps, input),
    listTablesUsecase: () => listTablesUsecase(deps),
  };
}

export type OrderUsecases = ReturnType<typeof createOrderUsecases>;
