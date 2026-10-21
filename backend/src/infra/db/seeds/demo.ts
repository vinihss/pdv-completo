// Seed de DEMONSTRAÇÃO — o seed base (store_settings, usuários, catálogo
// mínimo, mesas) + catálogo demo (categorias, grupos de cozinha e ~30
// produtos), 40 clientes com endereço georreferenciado e 30 dias de histórico
// de comandas, gavetas, entregas, alertas e auditoria.
//
// Veio de `src/infra/db/seed-demo.ts`; aquele arquivo virou um wrapper fino
// que delega para cá. O catálogo de seeds (`seeds/manifest.json`) declara
// este seed com o id `demo` (e `requiresPostgis: true` — as posições dos
// motoboys e a geometria das entregas usam ST_*).
//
// O plano é construído em memória ANTES de qualquer INSERT e com RNG
// determinístico (semente fixa), então os ids `demo-*` e o conteúdo de cada
// comanda são reprodutíveis entre execuções — qualquer bug vira reproduzível.
//
// ATENÇÃO: este seed cria dados FICTÍCIOS. Nunca em produção — lá o caminho
// é o seed `prod` (store_settings real + um manager com PIN temporário).
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { closeDatabase, db, type Tx } from "../client.js";
import { runBaseSeed } from "./base.js";
import { round2 } from "../../../domain/money.js";
import {
  alerts,
  auditLog,
  cashDrawerMovements,
  cashDrawers,
  categories,
  customerAddresses,
  customers,
  deliveries,
  kitchenGroups,
  orderItems,
  orderPayments,
  orders,
  products,
  restaurantTables,
  stockMovements,
  storeSettings,
  users,
} from "../schema.js";
import {
  BASE_WEIGHTS,
  CUSTOMER_NAMES,
  DEMO_BASE_LAT,
  DEMO_BASE_LNG,
  DEMO_CATEGORIES,
  DEMO_KITCHEN_GROUPS,
  DEMO_PRODUCTS,
  LOW_STOCK_TARGETS,
  NEIGHBORHOODS,
  ORDER_ALERT_AUDIENCE,
  STREETS,
  isoMinus,
  isoOnDay,
  isoPlus,
  pad2,
} from "./demo/fixtures.js";
import {
  buildPlan,
  type CatalogProduct,
  type Ctx,
  type PayMethod,
  type People,
  type PlanDay,
  type PlanDrawer,
  type PlanOrder,
} from "./demo/plan.js";

// ------------------------------------------------------------
// Fase de dados (banco): catálogo, clientes, pessoas e settings.
// ------------------------------------------------------------
function parseEnabled(raw: string): PayMethod[] {
  const all: PayMethod[] = ["cash", "card", "pix", "other"];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return all;
    const valid = parsed.filter((m): m is PayMethod => all.includes(m as PayMethod));
    return valid.length > 0 ? valid : all;
  } catch {
    return all;
  }
}

async function ensureCatalog(): Promise<void> {
  await db.transaction(async (tx) => {
    const cats = await tx
      .insert(categories)
      .values(DEMO_CATEGORIES)
      .onConflictDoNothing({ target: categories.id })
      .returning();
    const grps = await tx
      .insert(kitchenGroups)
      .values(DEMO_KITCHEN_GROUPS)
      .onConflictDoNothing({ target: kitchenGroups.id })
      .returning();

    const catRows = await tx.select({ id: categories.id, name: categories.name }).from(categories).orderBy(asc(categories.name));
    const grpRows = await tx.select({ id: kitchenGroups.id, name: kitchenGroups.name }).from(kitchenGroups).orderBy(asc(kitchenGroups.name));
    const catByName = new Map(catRows.map((r) => [r.name, r.id]));
    const grpByName = new Map(grpRows.map((r) => [r.name, r.id]));

    let created = 0;
    for (const def of DEMO_PRODUCTS) {
      const categoryId = catByName.get(def.category) ?? null;
      const kitchenGroupId = grpByName.get(def.group) ?? null;
      if (!categoryId || !kitchenGroupId) {
        throw new Error(`[seed:demo] categoria/grupo ausente para "${def.name}" (${def.category} / ${def.group})`);
      }
      const [row] = await tx
        .insert(products)
        .values({
          id: `demo-p-${def.slug}`,
          categoryId,
          kitchenGroupId,
          name: def.name,
          description: def.description,
          price: def.price,
          costPrice: def.cost,
          trackStock: def.track ?? false,
          lowStockThreshold: def.threshold ?? 0,
          unit: def.unit ?? "un",
          featured: def.featured ?? false,
          variations: JSON.stringify(def.variations ?? []),
        })
        .onConflictDoNothing({ target: products.id })
        .returning();
      if (row) created++;
    }
    console.log(
      `[seed:demo] catálogo: +${cats.length} categorias, +${grps.length} grupos de cozinha, +${created}/${DEMO_PRODUCTS.length} produtos novos`,
    );
  });
}

async function ensureCustomers(): Promise<void> {
  await db.transaction(async (tx) => {
    const cust = await tx
      .insert(customers)
      .values(
        CUSTOMER_NAMES.map((name, i) => ({
          id: `demo-cust-${pad2(i + 1)}`,
          name,
          phone: `1198888${String(i).padStart(4, "0")}`,
          notes: i % 4 === 0 ? "Cliente de demonstração" : null,
        })),
      )
      .onConflictDoNothing({ target: customers.id })
      .returning();

    // Grade 4x4 em volta da base: coordenadas determinísticas (o seed não
    // consome o RNG fora do plano) e distintas o bastante para o mapa não
    // sobrepor os 16 markers.
    const addressRows = Array.from({ length: 16 }, (_, i) => ({
      id: `demo-addr-${pad2(i + 1)}`,
      customerId: `demo-cust-${pad2(i + 1)}`,
      label: i % 3 === 0 ? "Casa" : "Trabalho",
      street: STREETS[i % STREETS.length]!,
      number: String(10 + ((i * 37) % 480)),
      complement: i % 2 === 0 ? `Apto ${100 + i * 3}` : null,
      neighborhood: NEIGHBORHOODS[i % NEIGHBORHOODS.length]!,
      city: "São Paulo",
      state: "SP",
      isDefault: true,
      latitude: DEMO_BASE_LAT + (Math.floor(i / 4) - 1.5) * 0.02,
      longitude: DEMO_BASE_LNG + ((i % 4) - 1.5) * 0.02,
    }));

    const addr = await tx
      .insert(customerAddresses)
      .values(addressRows)
      .onConflictDoNothing({ target: customerAddresses.id })
      .returning();

    // Backfill das coordenadas: bancos semeados antes desta mudança já têm os
    // 16 endereços sem lat/lng e o `onConflictDoNothing` acima não os toca —
    // sem este UPDATE, reexecutar o seed deixaria o mapa sem markers de pedido.
    for (const a of addressRows) {
      await tx
        .update(customerAddresses)
        .set({ latitude: a.latitude, longitude: a.longitude })
        .where(and(eq(customerAddresses.id, a.id), isNull(customerAddresses.latitude)));
    }

    console.log(`[seed:demo] clientes: +${cust.length}/40 novos, +${addr.length}/16 endereços novos`);
  });
}

async function resolvePeople(): Promise<People> {
  const rows = await db.select({ id: users.id, name: users.name, role: users.role }).from(users);
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  const byRole = (role: (typeof rows)[number]["role"]) => rows.find((r) => r.role === role)?.id ?? null;

  const ana = byName.get("Ana Ribeiro") ?? byRole("waiter");
  const roberto = byName.get("Roberto Alves") ?? byRole("manager");
  if (!ana || !roberto) {
    throw new Error("[seed:demo] usuários base ausentes (garçom/gerente) — rode o seed base antes.");
  }
  // Ordem estável (por nome) para atribuir as entregas em rota sempre aos
  // mesmos motoboys entre execuções: `rows` não tem ORDER BY e a atribuição
  // ficaria não-determinística.
  const couriers = rows
    .filter((r) => r.role === "courier")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => r.id);
  const entregador = byName.get("Entregador Teste") ?? byRole("courier") ?? roberto;
  return {
    ana,
    carlos: byName.get("Carlos Lima") ?? ana,
    roberto,
    caixa: byName.get("Caixa Teste") ?? byRole("cashier") ?? roberto,
    entregador,
    couriers: couriers.length ? couriers : [entregador],
    system: rows.find((r) => r.id === "system")?.id ?? byRole("system") ?? roberto,
  };
}

async function loadCtx(people: People): Promise<Ctx> {
  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, "singleton")).limit(1);
  if (!settings) throw new Error("[seed:demo] store_settings ausente após o seed base.");

  // Taxa de delivery precisa ser > 0 para as comandas de entrega terem total
  // com taxa (sem isso o checkout self-service cobraria 0). Ajuste de
  // CONFIGURAÇÃO, não dado de demonstração: o cleanup do cabeçalho não o reverte.
  let fee = settings.deliveryFee;
  if (fee <= 0) {
    fee = 7.9;
    await db.update(storeSettings).set({ deliveryFee: 7.9 }).where(eq(storeSettings.id, "singleton"));
    console.log("[seed:demo] store_settings.delivery_fee: 0 → 7,90 (não revertido pelo cleanup)");
  }
  const enabled = parseEnabled(settings.enabledPaymentMethods);

  const prodRows = await db
    .select({
      id: products.id,
      name: products.name,
      price: products.price,
      costPrice: products.costPrice,
      trackStock: products.trackStock,
      lowStockThreshold: products.lowStockThreshold,
      variations: products.variations,
    })
    .from(products)
    .where(eq(products.active, true))
    .orderBy(asc(products.name));

  const weightByName = new Map<string, number>([
    ...Object.entries(BASE_WEIGHTS),
    ...DEMO_PRODUCTS.map((d) => [d.name, d.weight] as [string, number]),
  ]);
  const catalog: CatalogProduct[] = prodRows
    .map((r) => ({ ...r, weight: weightByName.get(r.name) ?? 0 }))
    .filter((p) => p.weight > 0);
  if (catalog.length === 0) throw new Error("[seed:demo] catálogo vazio — o seed base não rodou?");

  const allTables = await db.select().from(restaurantTables).orderBy(asc(restaurantTables.number));
  const freeTables = allTables.filter((t) => t.status === "free");
  const tables = freeTables.length > 0 ? freeTables : allTables;
  if (allTables.length === 0) console.log("[seed:demo] nenhuma mesa — comandas de mesa viram balcão.");

  const addrRows = await db
    .select({
      id: customerAddresses.id,
      customerId: customerAddresses.customerId,
      customerName: customers.name,
      street: customerAddresses.street,
      number: customerAddresses.number,
      complement: customerAddresses.complement,
      neighborhood: customerAddresses.neighborhood,
      city: customerAddresses.city,
      state: customerAddresses.state,
    })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .orderBy(asc(customerAddresses.id));
  if (addrRows.length === 0) console.log("[seed:demo] nenhum endereço — pedidos de delivery viram balcão.");

  return {
    people,
    catalog,
    catalogByName: new Map(catalog.map((p) => [p.name, p])),
    productById: new Map(prodRows.map((p) => [p.id, { name: p.name, trackStock: p.trackStock }])),
    trackedProducts: prodRows.filter((p) => p.trackStock).map((p) => ({ id: p.id, name: p.name, costPrice: p.costPrice, lowStockThreshold: p.lowStockThreshold })),
    tables,
    addresses: addrRows,
    couriers: people.couriers,
    fee,
    enabled,
  };
}

// ------------------------------------------------------------
// Ledger de estoque: movimento inicial `adjustment` por produto rastreado,
// calculado para que o saldo FINAL (inicial − tudo que é vendido no plano)
// termine exatamente no alvo. Fórmula rerun-estável:
//
//   init = alvo + vendido_no_plano − saldo_não_venda
//   saldo_não_venda = SUM(delta) − SUM(delta de venda demo-*)
//
// Na 1ª execução só existem os ajustes do seed base (e o init ainda não);
// numa reexecução os deltas de venda puxam os dois termos juntos e o valor
// recalculado é irrelevante — a PK `demo-sm-init-<produto>` já existe e o
// INSERT é DO NOTHING. `init` é gravado ANTES dos dias, então o saldo nunca
// fica negativo durante o replay (começa em alvo+vendido, termina em alvo).
// ------------------------------------------------------------
async function ensureInitialAdjustments(tx: Tx, plan: PlanDay[], ctx: Ctx): Promise<void> {
  const sold = new Map<string, number>();
  for (const day of plan) {
    for (const order of day.orders) {
      for (const item of order.items) {
        if (item.status === "cancelled") continue; // cancelado não gera venda
        sold.set(item.productId, (sold.get(item.productId) ?? 0) + item.quantity);
      }
    }
  }

  let created = 0;
  for (const p of ctx.trackedProducts) {
    const target = LOW_STOCK_TARGETS[p.name] ?? Math.max(Math.ceil(p.lowStockThreshold * 2), 10);
    if (target <= 0) continue; // sem alvo plausível → deixa o saldo do base

    const res = (await tx.execute(sql`
      SELECT COALESCE(SUM(quantity_delta), 0)::double precision AS total,
             COALESCE(SUM(quantity_delta) FILTER (WHERE id LIKE 'demo-%' AND type = 'sale'), 0)::double precision AS demo_sales
      FROM stock_movement
      WHERE product_id = ${p.id}`)) as { rows: Array<{ total: string | number; demo_sales: string | number }> };
    const nonSale = Number(res.rows[0]?.total ?? 0) - Number(res.rows[0]?.demo_sales ?? 0);
    const delta = round2(target + (sold.get(p.id) ?? 0) - nonSale);

    const [row] = await tx
      .insert(stockMovements)
      .values({
        id: `demo-sm-init-${p.id}`,
        productId: p.id,
        type: "adjustment",
        quantityDelta: delta,
        unitCost: p.costPrice,
        note: "Estoque inicial (seed:demo)",
        createdBy: ctx.people.roberto,
        createdAt: isoOnDay(31, 9, 0), // antes do 1º dia de histórico (seq cronológico)
      })
      .onConflictDoNothing({ target: stockMovements.id })
      .returning();
    if (row) created++;
  }
  console.log(`[seed:demo] estoque: +${created}/${ctx.trackedProducts.length} ajustes iniciais novos`);
}

// ------------------------------------------------------------
// Inserção de comandas + filhos (só para comandas NOVAS — o RETURNING do
// INSERT..ON CONFLICT DO NOTHING devolve apenas as linhas que entraram).
// ------------------------------------------------------------
function orderRow(o: PlanOrder) {
  return {
    id: o.id,
    tableId: o.tableId,
    customerId: o.customerId,
    tabLabel: o.tabLabel,
    waiterId: o.waiterId,
    status: o.status,
    openedAt: o.openedAt,
    closedAt: o.closedAt,
    paymentMethod: o.paymentMethod,
    paymentConfirmedAt: o.paymentConfirmedAt,
    paymentConfirmedBy: o.paymentConfirmedBy,
    channel: o.channel,
    deliveryFee: o.deliveryFee,
    cancelReason: o.cancelReason,
    notes: o.notes,
  };
}

/** Texto do alerta — réplica de describeOrderAlert (application/alert). */
function describeAlert(order: PlanOrder): { title: string; body: string } {
  const CHANNEL_LABEL: Record<string, string> = { balcao: "Balcão", web: "página" };
  const channel = CHANNEL_LABEL[order.channel] ?? order.channel;
  if (order.channel === "web") {
    const who = order.customerName?.trim() || order.tabLabel;
    return { title: who ? `Novo pedido de ${who}` : "Novo pedido de entrega", body: `Entrega · ${channel}` };
  }
  const label = order.tabLabel ?? (order.tableNumber ? `Mesa ${order.tableNumber}` : null);
  return { title: label ? `Nova comanda · ${label}` : "Nova comanda", body: channel };
}

type AuditRow = { id: string; userId: string; action: string; orderId: string | null; details: string; createdAt: string };

async function insertOrderChildren(tx: Tx, order: PlanOrder, ctx: Ctx): Promise<void> {
  // itens
  if (order.items.length > 0) {
    await tx
      .insert(orderItems)
      .values(
        order.items.map((it, i) => ({
          id: `demo-oi-${order.key}-${pad2(i + 1)}`,
          orderId: order.id,
          productId: it.productId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          costPrice: it.costPrice,
          selectedVariations: it.selectedVariations,
          notes: it.notes,
          status: it.status,
          version: it.version,
          createdBy: order.waiterId,
          createdAt: order.openedAt,
          updatedAt: it.updatedAt ?? order.closedAt ?? order.openedAt,
        })),
      )
      .onConflictDoNothing({ target: orderItems.id });
  }

  // pagamentos
  if (order.payments.length > 0) {
    const confirmed = order.paymentConfirmedAt !== null;
    await tx
      .insert(orderPayments)
      .values(
        order.payments.map((p, i) => ({
          id: `demo-pay-${order.key}-${pad2(i + 1)}`,
          orderId: order.id,
          method: p.method,
          amount: p.amount,
          received: p.received,
          change: p.change,
          confirmed,
          confirmedAt: confirmed ? order.paymentConfirmedAt : null,
          confirmedBy: confirmed ? order.paymentConfirmedBy : null,
          createdBy: ctx.people.caixa,
          createdAt: order.closedAt ? isoMinus(order.closedAt, 1) : order.openedAt,
        })),
      )
      .onConflictDoNothing({ target: orderPayments.id });
  }

  // ledger: 'sale' só para produto RASTREADO, item não cancelado e comanda
  // não cancelada (cancelamento é net-zero: sem venda e sem estorno — ver
  // o cabeçalho do arquivo).
  if (order.status !== "cancelled") {
    const saleRows = order.items.flatMap((it, i) => {
      const product = ctx.productById.get(it.productId);
      if (!product?.trackStock || it.status === "cancelled") return [];
      return [
        {
          id: `demo-sm-sale-${order.key}-${pad2(i + 1)}`,
          productId: it.productId,
          type: "sale" as const,
          quantityDelta: -it.quantity,
          orderId: order.id,
          orderItemId: `demo-oi-${order.key}-${pad2(i + 1)}`,
          note: "Venda (seed:demo)",
          createdBy: order.waiterId,
          createdAt: order.openedAt,
        },
      ];
    });
    if (saleRows.length > 0) {
      await tx.insert(stockMovements).values(saleRows).onConflictDoNothing({ target: stockMovements.id });
    }
  }

  // entrega
  if (order.delivery) {
    await tx
      .insert(deliveries)
      .values({
        id: `demo-del-${order.key}`,
        orderId: order.id,
        courierId: order.delivery.courierId,
        address: order.delivery.address,
        distanceKm: order.delivery.distanceKm,
        estimatedMinutes: order.delivery.estimatedMinutes,
        status: order.delivery.status,
        dispatchedAt: order.delivery.dispatchedAt,
        deliveredAt: order.delivery.deliveredAt,
        notes: order.delivery.notes,
        createdAt: order.openedAt,
      })
      .onConflictDoNothing({ target: deliveries.id });
  }

  // sino (read_at nulo = não lido, só para comandas abertas ativas)
  const alertText = describeAlert(order);
  await tx
    .insert(alerts)
    .values({
      id: `demo-alert-${order.key}`,
      kind: "order_created",
      title: alertText.title,
      body: alertText.body,
      orderId: order.id,
      channel: order.channel,
      audienceRoles: [...ORDER_ALERT_AUDIENCE],
      readAt: order.alertReadAt,
      createdAt: order.openedAt,
    })
    .onConflictDoNothing({ target: alerts.id });

  // auditoria — as MESMAS ações que a aplicação grava (ver usecases)
  const auditRows: AuditRow[] = [
    {
      id: `demo-a-open-${order.key}`,
      userId: order.waiterId,
      action: "order_opened",
      orderId: order.id,
      details: JSON.stringify({ tableId: order.tableId, customerId: order.customerId, tabLabel: order.tabLabel }),
      createdAt: order.openedAt,
    },
  ];
  if (order.payments.length > 0) {
    auditRows.push({
      id: `demo-a-pay-${order.key}`,
      userId: ctx.people.caixa,
      action: "payment_registered",
      orderId: order.id,
      details: JSON.stringify({
        payments: order.payments.map((p) => ({ method: p.method, amount: p.amount, confirmed: order.paymentConfirmedAt !== null })),
      }),
      createdAt: order.closedAt ? isoMinus(order.closedAt, 2) : order.openedAt,
    });
  }
  if (order.status === "closed") {
    auditRows.push({
      id: `demo-a-close-${order.key}`,
      userId: ctx.people.caixa,
      action: "order_closed",
      orderId: order.id,
      details: JSON.stringify({ payments: order.payments.map((p) => ({ method: p.method, amount: p.amount, confirmed: true })) }),
      createdAt: order.closedAt!,
    });
  }
  if (order.status === "cancelled") {
    auditRows.push({
      id: `demo-a-cancel-${order.key}`,
      userId: ctx.people.roberto,
      action: "order_cancelled",
      orderId: order.id,
      details: JSON.stringify({ reason: order.cancelReason }),
      createdAt: order.alertReadAt ?? isoPlus(order.openedAt, 10),
    });
  }
  if (order.delivery) {
    auditRows.push({
      id: `demo-a-delivery-${order.key}`,
      userId: ctx.people.system,
      action: "delivery_created",
      orderId: order.id,
      details: JSON.stringify({ channel: order.channel, addressText: order.delivery.address }),
      createdAt: order.openedAt,
    });
    if (order.delivery.status === "delivered") {
      auditRows.push({
        id: `demo-a-deliverydone-${order.key}`,
        userId: order.delivery.courierId ?? ctx.people.entregador,
        action: "delivery_completed",
        orderId: order.id,
        details: JSON.stringify({}),
        createdAt: order.delivery.deliveredAt ?? order.openedAt,
      });
    }
  }
  await tx.insert(auditLog).values(auditRows).onConflictDoNothing({ target: auditLog.id });
}

async function insertDayOrders(tx: Tx, day: PlanDay, ctx: Ctx): Promise<number> {
  let created = 0;
  for (const order of day.orders) {
    const [inserted] = await tx
      .insert(orders)
      .values(orderRow(order))
      .onConflictDoNothing({ target: orders.id })
      .returning();
    // mesa ocupada de comanda aberta: idempotente, mesmo se a comanda já
    // existir de uma execução anterior (alguém pode ter liberado a mesa).
    if (order.status === "open" && order.tableId) {
      await tx.update(restaurantTables).set({ status: "occupied" }).where(eq(restaurantTables.id, order.tableId));
    }
    if (!inserted) continue;
    await insertOrderChildren(tx, order, ctx);
    created++;
  }
  return created;
}

async function insertDrawer(tx: Tx, drawer: PlanDrawer, ctx: Ctx, dayKey: string): Promise<boolean> {
  // uq_cash_drawer_single_open: só pode existir UMA gaveta aberta. Se já
  // houver uma (do app ou de outra ferramenta), a gaveta de hoje é pulada.
  if (drawer.id === "demo-drawer-today") {
    const open = await tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.status, "open") });
    if (open) {
      console.log(`[seed:demo] gaveta aberta já existe (${open.id}) — demo-drawer-today pulada`);
      return false;
    }
  }

  const [row] = await tx
    .insert(cashDrawers)
    .values({
      id: drawer.id,
      status: drawer.closedAt ? "closed" : "open",
      openedAt: drawer.openedAt,
      openedBy: drawer.openedBy,
      openingAmount: drawer.openingAmount,
      closedAt: drawer.closedAt,
      closedBy: drawer.closedBy,
      closingExpected: drawer.closingExpected,
      closingCounted: drawer.closingCounted,
      closingDifference: drawer.closingDifference,
      closingNote: drawer.closingNote,
    })
    .onConflictDoNothing({ target: cashDrawers.id })
    .returning();
  if (!row) return false; // já existia (reexecução)

  if (drawer.movements.length > 0) {
    await tx
      .insert(cashDrawerMovements)
      .values(
        drawer.movements.map((m) => ({
          id: m.id,
          drawerId: drawer.id,
          type: m.type,
          amount: m.amount,
          note: m.note,
          createdBy: ctx.people.caixa,
          createdAt: m.createdAt,
        })),
      )
      .onConflictDoNothing({ target: cashDrawerMovements.id });
  }

  const auditRows: AuditRow[] = [
    {
      id: `demo-a-draweropen-${dayKey}`,
      userId: drawer.openedBy,
      action: "cash_drawer_opened",
      orderId: null,
      details: JSON.stringify({ drawerId: drawer.id, openingAmount: drawer.openingAmount }),
      createdAt: drawer.openedAt,
    },
  ];
  drawer.movements.forEach((m, i) => {
    auditRows.push({
      id: `demo-a-cdm-${dayKey}-${pad2(i + 1)}`,
      userId: ctx.people.caixa,
      action: m.type === "sangria" ? "cash_drawer_sangria" : "cash_drawer_suprimento",
      orderId: null,
      details: JSON.stringify({ drawerId: drawer.id, amount: m.amount, note: m.note }),
      createdAt: m.createdAt,
    });
  });
  if (drawer.closedAt) {
    auditRows.push({
      id: `demo-a-drawerclose-${dayKey}`,
      userId: drawer.closedBy ?? ctx.people.caixa,
      action: "cash_drawer_closed",
      orderId: null,
      details: JSON.stringify({
        drawerId: drawer.id,
        openedBy: drawer.openedBy,
        openingAmount: drawer.openingAmount,
        expected: drawer.closingExpected,
        counted: drawer.closingCounted,
        difference: drawer.closingDifference,
        note: drawer.closingNote,
      }),
      createdAt: drawer.closedAt,
    });
  }
  await tx.insert(auditLog).values(auditRows).onConflictDoNothing({ target: auditLog.id });
  return true;
}

// ------------------------------------------------------------
// Resumo + validação — imprime as contagens reais e FALHA (exit 1) se algum
// invariante do seed estiver violado.
// ------------------------------------------------------------
async function q(query: string): Promise<Record<string, unknown>[]> {
  const res = (await db.execute(sql.raw(query))) as { rows: Record<string, unknown>[] };
  return res.rows;
}

const n = (v: unknown): number => Number(v);

function printRows(title: string, rows: Record<string, unknown>[]): void {
  console.log(`[seed:demo] ${title}`);
  for (const r of rows) {
    console.log(`  ${JSON.stringify(r)}`);
  }
}

async function printSummaryAndValidate(): Promise<void> {
  const problems: string[] = [];

  printRows(
    "contagens gerais",
    await q(`SELECT (SELECT count(*) FROM product) AS produtos,
                    (SELECT count(*) FROM category) AS categorias,
                    (SELECT count(*) FROM customer) AS clientes,
                    (SELECT count(*) FROM "user") AS usuarios,
                    (SELECT count(*) FROM "order") AS comandas,
                    (SELECT count(*) FROM outbox_event) AS outbox_eventos`),
  );
  printRows("comandas demo por status", await q(`SELECT status, count(*) AS qtd FROM "order" WHERE id LIKE 'demo-%' GROUP BY status ORDER BY status`));
  printRows("comandas demo por dia", await q(`SELECT substr(opened_at, 1, 10) AS dia, count(*) AS qtd FROM "order" WHERE id LIKE 'demo-%' GROUP BY 1 ORDER BY 1`));
  printRows(
    "pagamentos demo por método",
    await q(`SELECT method, count(*) AS qtd, round(sum(amount)::numeric, 2) AS total FROM order_payment WHERE id LIKE 'demo-%' GROUP BY method ORDER BY method`),
  );
  printRows("entregas demo por status", await q(`SELECT status, count(*) AS qtd FROM delivery WHERE id LIKE 'demo-%' GROUP BY status ORDER BY status`));
  printRows("gavetas", await q(`SELECT status, count(*) AS qtd FROM cash_drawer GROUP BY status ORDER BY status`));
  printRows(
    "saldo do ledger por produto rastreado",
    await q(`SELECT p.name, p.low_stock_threshold, round(sum(sm.quantity_delta)::numeric, 2) AS saldo
             FROM product p JOIN stock_movement sm ON sm.product_id = p.id
             WHERE p.track_stock GROUP BY p.id, p.name, p.low_stock_threshold ORDER BY p.name`),
  );
  printRows(
    "sino / auditoria / marcador",
    await q(`SELECT (SELECT count(*) FROM alert WHERE read_at IS NULL) AS alertas_nao_lidos,
                    (SELECT count(*) FROM audit_log) AS linhas_auditoria,
                    (SELECT count(*) FROM audit_log WHERE id = 'demo-a-seed') AS marcador`),
  );

  // ---- invariantes ----
  const [closed] = await q(`SELECT count(*) AS qtd FROM "order" WHERE id LIKE 'demo-%' AND status = 'closed'`);
  if (n(closed?.qtd) < 150) problems.push(`esperado >= 150 comandas fechadas, encontrado ${closed?.qtd}`);

  const [days] = await q(`SELECT count(DISTINCT substr(opened_at, 1, 10)) AS dias FROM "order" WHERE id LIKE 'demo-%'`);
  if (n(days?.dias) < 31) problems.push(`esperado >= 31 dias distintos (30 de histórico + hoje), encontrado ${days?.dias}`);

  const [negCount] = await q(
    `SELECT count(*) AS qtd FROM (
       SELECT p.id FROM product p JOIN stock_movement sm ON sm.product_id = p.id
       WHERE p.track_stock GROUP BY p.id HAVING sum(sm.quantity_delta) < 0) t`,
  );
  if (n(negCount?.qtd) > 0) problems.push(`${negCount?.qtd} produto(s) com saldo negativo no ledger`);

  const [payMismatch] = await q(
    `SELECT count(*) AS qtd FROM "order" o
     WHERE o.id LIKE 'demo-%' AND o.status = 'closed'
       AND abs( COALESCE((SELECT sum(p.amount) FROM order_payment p WHERE p.order_id = o.id), 0)
              - ( COALESCE((SELECT sum(oi.unit_price * oi.quantity) FROM order_item oi
                            WHERE oi.order_id = o.id AND oi.status <> 'cancelled'), 0)
                + COALESCE(o.delivery_fee, 0) ) ) > 0.01`,
  );
  if (n(payMismatch?.qtd) > 0) problems.push(`${payMismatch?.qtd} comanda(s) fechada(s) com soma de pagamentos != total`);

  const [payBad] = await q(
    `SELECT count(*) AS qtd FROM "order" o
     WHERE o.id LIKE 'demo-%' AND o.status = 'closed'
       AND ( EXISTS (SELECT 1 FROM order_payment p WHERE p.order_id = o.id AND NOT p.confirmed)
            OR NOT EXISTS (SELECT 1 FROM order_payment p WHERE p.order_id = o.id) )`,
  );
  if (n(payBad?.qtd) > 0) problems.push(`${payBad?.qtd} comanda(s) fechada(s) sem pagamento confirmado`);

  const [cancelledBad] = await q(
    `SELECT count(*) AS qtd FROM "order" o
     WHERE o.id LIKE 'demo-%' AND o.status = 'cancelled'
       AND ( EXISTS (SELECT 1 FROM order_payment p WHERE p.order_id = o.id)
            OR EXISTS (SELECT 1 FROM order_item oi WHERE oi.order_id = o.id AND oi.status <> 'cancelled') )`,
  );
  if (n(cancelledBad?.qtd) > 0) problems.push(`${cancelledBad?.qtd} comanda(s) cancelada(s) com pagamento ou item não cancelado`);

  const [cashOutside] = await q(
    `SELECT count(*) AS qtd FROM order_payment p
     WHERE p.id LIKE 'demo-%' AND p.method = 'cash' AND p.confirmed
       AND NOT EXISTS (SELECT 1 FROM cash_drawer d WHERE d.status = 'closed'
                        AND p.confirmed_at >= d.opened_at AND p.confirmed_at <= d.closed_at)`,
  );
  if (n(cashOutside?.qtd) > 0) problems.push(`${cashOutside?.qtd} pagamento(s) em dinheiro fora de qualquer gaveta fechada`);

  const [marker] = await q(`SELECT id FROM audit_log WHERE id = 'demo-a-seed'`);
  if (!marker) problems.push("marcador demo-a-seed ausente");

  if (problems.length > 0) {
    for (const p of problems) console.error(`[seed:demo] FALHA: ${p}`);
    throw new Error(`seed:demo: ${problems.length} validação(ões) falharam (ver acima)`);
  }
  console.log("[seed:demo] validações OK: ledger >= 0, pagamentos conferem, gavetas coerentes, marcador presente.");
}

// ------------------------------------------------------------
// Rastreamento demo: última posição dos motoboys e geometria dos pedidos.
//
// O mapa do gerente (`GET /manager/deliveries/locations`) só mostra entregador
// com entrega `out_for_delivery` E linha em `courier_location` — sem o ping do
// app do entregador, o seed precisa plantar a última posição conhecida. E o
// marker de pedido depende do endereço georreferenciado; sem isso, o mapa de
// um banco de demonstração nasce vazio.
//
// Idempotente: `ON CONFLICT` no ponto e `UPDATE ... WHERE ... IS NULL` na
// geometria, então reexecutar o seed só completa o que falta.
// ------------------------------------------------------------
async function ensureCourierDemo(ctx: Ctx): Promise<void> {
  // Posição de cada motoboy: ponto determinístico em volta da base (na cidade,
  // não no mar), com `position` preenchido — o mapa lê lat/lng, mas o GIS e o
  // roteamento leem a geometria.
  for (const [i, courierId] of ctx.couriers.entries()) {
    const latitude = round2(DEMO_BASE_LAT + 0.012 + i * 0.008);
    const longitude = round2(DEMO_BASE_LNG + 0.01 - i * 0.007);
    await db.execute(sql`
      INSERT INTO courier_location (courier_id, latitude, longitude, accuracy, updated_at, position)
      VALUES (${courierId}, ${latitude}, ${longitude}, 15, ${new Date().toISOString()},
              ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326))
      ON CONFLICT (courier_id) DO UPDATE
        SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
            accuracy = EXCLUDED.accuracy, updated_at = EXCLUDED.updated_at,
            position = EXCLUDED.position`);
  }

  // Geometria da entrega: mesma projeção da aplicação (endereço padrão do
  // cliente da comanda). Só preenche o que está nulo — não sobrescreve um
  // pedido cuja coordenada já tenha sido ajustada no mapa do gerente.
  await db.execute(sql`
    UPDATE delivery d
    SET coordinate = ST_SetSRID(ST_MakePoint(a.longitude, a.latitude), 4326)
    FROM "order" o
    JOIN customer_address a ON a.customer_id = o.customer_id AND a.is_default
    WHERE d.order_id = o.id AND d.coordinate IS NULL
      AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL`);

  // Região, quando houver alguma desenhada: mesma regra do
  // `assignDeliveryCoordinate` (a menor que contém o ponto).
  await db.execute(sql`
    UPDATE delivery d
    SET region_id = (SELECT r.id FROM delivery_region r
                     WHERE ST_Contains(r.area_geografica, d.coordinate)
                     ORDER BY ST_Area(r.area_geografica::geography) LIMIT 1)
    WHERE d.region_id IS NULL AND d.coordinate IS NOT NULL`);

  console.log(
    `[seed:demo] rastreamento: ${ctx.couriers.length} motoboy(s) posicionado(s) + geometria das entregas`,
  );
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------
export async function runDemoSeed(): Promise<void> {
  console.log("[seed:demo] 1/7 seed base (migrations + usuários + catálogo inicial)…");
  await runBaseSeed();

  console.log("[seed:demo] 2/7 pessoas, catálogo demo e clientes…");
  const people = await resolvePeople();
  await ensureCatalog();
  await ensureCustomers();
  const ctx = await loadCtx(people);

  console.log("[seed:demo] 3/7 construindo plano (30 dias de histórico + comandas abertas)…");
  const plan = buildPlan(ctx);
  const plannedOrders = plan.reduce((sum, d) => sum + d.orders.length, 0);
  const plannedClosed = plan.reduce((sum, d) => sum + d.orders.filter((o) => o.status === "closed").length, 0);
  console.log(
    `[seed:demo] plano: ${plannedOrders} comandas (${plannedClosed} fechadas, ${plan.reduce((s, d) => s + d.orders.filter((o) => o.status === "cancelled").length, 0)} canceladas, ${plan.find((d) => d.isToday)?.orders.length ?? 0} de hoje) · ${plan.length - 1} gavetas históricas · métodos: ${ctx.enabled.join(", ")}`,
  );

  console.log("[seed:demo] 4/7 ajustes iniciais do ledger…");
  await db.transaction(async (tx) => {
    await ensureInitialAdjustments(tx, plan, ctx);
  });

  console.log("[seed:demo] 5/7 dias de histórico (uma transação por dia, do mais antigo ao recente)…");
  for (const day of plan) {
    if (day.isToday) continue;
    const created = await db.transaction(async (tx) => {
      const count = await insertDayOrders(tx, day, ctx);
      if (day.drawer) await insertDrawer(tx, day.drawer, ctx, `d${pad2(day.daysAgo)}`);
      return count;
    });
    console.log(`[seed:demo]   dia -${pad2(day.daysAgo)}: ${created}/${day.orders.length} comandas novas`);
  }

  const today = plan.find((d) => d.isToday)!;
  const createdToday = await db.transaction(async (tx) => {
    const count = await insertDayOrders(tx, today, ctx);
    if (today.drawer) await insertDrawer(tx, today.drawer, ctx, "today");
    return count;
  });
  console.log(`[seed:demo]   hoje: ${createdToday}/${today.orders.length} comandas novas`);

  console.log("[seed:demo] 6/7 posição dos motoboys e geometria das entregas…");
  await ensureCourierDemo(ctx);

  console.log("[seed:demo] 7/7 marcador de conclusão + validação…");
  await db.transaction(async (tx) => {
    await tx
      .insert(auditLog)
      .values({
        id: "demo-a-seed",
        userId: people.roberto,
        action: "seed_demo",
        orderId: null,
        details: JSON.stringify({ note: "seed:demo concluído — marque este banco como demo; ver cabeçalho de seeds/demo.ts" }),
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing({ target: auditLog.id });
  });

  await printSummaryAndValidate();
}

// CLI próprio (`npm run seed:demo`). O guard é obrigatório: este módulo
// é importado pelo wrapper `seed-demo.ts` e pelo runner genérico
// (`seeds/apply.ts`) — sem o guard, o import dispararia o seed inteiro.
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemoSeed()
    .then(async () => {
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await closeDatabase();
      process.exit(1);
    });
}
