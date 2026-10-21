// CONSTRUTORES PUROS do plano do seed de demonstração — o histórico de 30
// dias e as comandas abertas de hoje, montados em memória ANTES de qualquer
// INSERT.
//
// O RNG (mulberry32 com semente fixa) mora AQUI e é consumido só na
// construção do plano: a fase de dados (`seeds/demo.ts`) nunca sorteia
// nada. É isso que torna os ids `demo-*` e o conteúdo de cada comanda
// reprodutíveis entre execuções — qualquer bug vira reproduzível.
//
// A ORDEM das chamadas importa: o RNG é uma sequência, então mudar a ordem
// em que `buildHistoryOrder`/`buildOpenOrders`/`buildHistoryDrawer`
// consomem números muda o histórico inteiro (e o ledger junto).

import { round2 } from "../../../../domain/money.js";
import { computeOrderTotal } from "../../../../domain/order-total.js";
import { restaurantTables } from "../../schema.js";
import {
  CANCEL_REASONS,
  ORDER_NOTES,
  TAB_LABELS,
  dayStartUtc,
  isoMinus,
  isoOnDay,
  isoPlus,
  pad2,
  type VariationDef,
} from "./fixtures.js";

// ------------------------------------------------------------
// RNG determinístico (mulberry32 com semente fixa): consumido SOMENTE na
// construção do plano em memória (fase síncrona), nunca durante as inserções.
// Isso torna os ids `demo-*` e o conteúdo de cada comanda reprodutíveis entre
// execuções — qualquer bug vira reproduzível.
// ------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x5de_2026);

const rng = {
  float: () => rand(),
  int: (min: number, max: number) => min + Math.floor(rand() * (max - min + 1)),
  chance: (p: number) => rand() < p,
  pick: <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!,
  /** Sorteio proporcional: entries = [valor, peso]. */
  weighted: <T>(entries: ReadonlyArray<readonly [T, number]>): T => {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [value, weight] of entries) {
      r -= weight;
      if (r <= 0) return value;
    }
    return entries[entries.length - 1]![0];
  },
};

// ------------------------------------------------------------
// Plano em memória (construído de forma síncrona e determinística ANTES de
// qualquer INSERT — as inserções nunca consomem o RNG).
// ------------------------------------------------------------
export type PayMethod = "cash" | "card" | "pix" | "other";
export type ItemStatus = "ordered" | "ready" | "delivered" | "cancelled";

export type CatalogProduct = {
  id: string;
  name: string;
  price: number;
  costPrice: number;
  trackStock: boolean;
  lowStockThreshold: number;
  variations: string;
  weight: number;
};

export type PlanItem = {
  productId: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  status: ItemStatus;
  selectedVariations: string;
  notes: string | null;
  version: number;
  /** momento da última transição (só comandas abertas; histórico usa closedAt) */
  updatedAt?: string;
};

export type PlanPayment = {
  method: PayMethod;
  amount: number;
  received: number | null;
  change: number | null;
};

export type PlanDelivery = {
  address: string;
  distanceKm: number;
  estimatedMinutes: number;
  status: "awaiting_courier" | "out_for_delivery" | "delivered" | "failed";
  courierId: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  notes: string | null;
};

export type PlanOrder = {
  key: string; // sufixo dos ids (hist-07-03 / open-04)
  id: string; // demo-<key>
  status: "open" | "closed" | "cancelled";
  tableId: string | null;
  tableNumber: string | null; // só p/ texto do alerta ("Mesa 3")
  tabLabel: string | null;
  customerId: string | null;
  customerName: string | null; // só p/ texto do alerta
  channel: "balcao" | "web";
  waiterId: string;
  openedAt: string;
  closedAt: string | null;
  cancelReason: string | null;
  deliveryFee: number | null;
  notes: string | null;
  items: PlanItem[];
  payments: PlanPayment[];
  paymentMethod: PayMethod | null;
  paymentConfirmedAt: string | null;
  paymentConfirmedBy: string | null;
  delivery: PlanDelivery | null;
  alertReadAt: string | null; // null = alerta não lido (sino com badge)
};

export type PlanDrawerMovement = {
  id: string;
  type: "sangria" | "suprimento";
  amount: number;
  note: string;
  createdAt: string;
};

export type PlanDrawer = {
  id: string;
  openedAt: string;
  openedBy: string;
  openingAmount: number;
  closedAt: string | null;
  closedBy: string | null;
  closingExpected: number | null;
  closingCounted: number | null;
  closingDifference: number | null;
  closingNote: string | null;
  movements: PlanDrawerMovement[];
};

export type PlanDay = {
  daysAgo: number; // 0 = hoje (só comandas abertas)
  orders: PlanOrder[];
  drawer: PlanDrawer | null; // null = gaveta de hoje pulada (já existe uma aberta)
  isToday: boolean;
};

export type People = {
  ana: string;
  carlos: string;
  roberto: string;
  caixa: string;
  entregador: string;
  // Todos os entregadores (papel `courier`). O seed distribui as entregas em
  // rota entre eles para o mapa do gerente mostrar mais de um motoboy.
  couriers: string[];
  system: string;
};

export type AddrRow = {
  id: string;
  customerId: string;
  customerName: string;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string | null;
};

export type TableRow = typeof restaurantTables.$inferSelect;

export type Ctx = {
  people: People;
  catalog: CatalogProduct[]; // só produtos com peso > 0 (participam do sorteio)
  catalogByName: Map<string, CatalogProduct>;
  productById: Map<string, { name: string; trackStock: boolean }>;
  trackedProducts: { id: string; name: string; costPrice: number; lowStockThreshold: number }[];
  tables: TableRow[]; // livres, ordenadas por número
  addresses: AddrRow[];
  couriers: string[]; // entregadores, para o pool de atribuição das entregas
  fee: number; // taxa de delivery (store_settings.delivery_fee)
  enabled: PayMethod[]; // store_settings.enabled_payment_methods
};

// ------------------------------------------------------------
// helpers de plano
// ------------------------------------------------------------
function parseVariationGroups(raw: string): VariationDef[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (g): g is VariationDef => !!g && typeof g === "object" && typeof g.name === "string" && Array.isArray(g.options) && g.options.length > 0,
    );
  } catch {
    return [];
  }
}

function pickVariationSelection(product: CatalogProduct): string {
  const groups = parseVariationGroups(product.variations);
  if (groups.length === 0) return "{}";
  // O primeiro grupo é o obrigatório quando existe (ex.: "Ponto da carne" do
  // X-Burger) — a aplicação recusaria item sem ele.
  return JSON.stringify({ [groups[0]!.name]: rng.pick(groups[0]!.options) });
}

function pickProduct(catalog: CatalogProduct[]): CatalogProduct {
  const total = catalog.reduce((s, p) => s + p.weight, 0);
  let r = rng.float() * total;
  for (const p of catalog) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return catalog[catalog.length - 1]!;
}

/**
 * Versão do item = f(status), espelhando os bumps do lock otimista do app:
 * ordered(1) → ready(2) → delivered(3); cancelamento a partir de ordered(1).
 */
const versionFor = (status: ItemStatus): number =>
  status === "ready" ? 2 : status === "delivered" ? 3 : 1;

function makeItem(product: CatalogProduct, status: ItemStatus, notes: string | null): PlanItem {
  return {
    productId: product.id,
    quantity: rng.weighted<number>([
      [1, 60],
      [2, 25],
      [3, 10],
      [4, 5],
    ]),
    unitPrice: product.price,
    costPrice: product.costPrice,
    status,
    selectedVariations: pickVariationSelection(product),
    notes,
    version: versionFor(status),
  };
}

function buildItems(catalog: CatalogProduct[], allCancelled: boolean): PlanItem[] {
  if (allCancelled) {
    // Comanda cancelada: 1–3 itens, todos cancelled (sem movimento no ledger).
    const items: PlanItem[] = [];
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const item = makeItem(pickProduct(catalog), "cancelled", i === 0 ? "Cancelado pelo garçom" : null);
      item.quantity = rng.int(1, 2);
      items.push(item);
    }
    return items;
  }
  const lines = rng.weighted<number>([
    [1, 8],
    [2, 22],
    [3, 30],
    [4, 22],
    [5, 12],
    [6, 6],
  ]);
  const items: PlanItem[] = [];
  for (let i = 0; i < lines; i++) {
    items.push(makeItem(pickProduct(catalog), "delivered", rng.chance(0.05) ? rng.pick(ORDER_NOTES) : null));
  }
  // ~12% das comandas têm um item cancelado (não conta no total nem no ledger)
  if (rng.chance(0.12)) {
    items.push(makeItem(pickProduct(catalog), "cancelled", "Cancelado pelo garçom"));
  }
  return items;
}

/** Total da comanda = MESMA fórmula de `domain/order-total.ts` (uma só). */
function orderItemsTotal(order: { items: PlanItem[]; deliveryFee: number | null }): number {
  return computeOrderTotal(order.items, order.deliveryFee);
}

function pickMethod(enabled: PayMethod[]): PayMethod {
  const weights: ReadonlyArray<readonly [PayMethod, number]> = [
    ["cash", 35],
    ["card", 35],
    ["pix", 25],
    ["other", 5],
  ];
  const available = weights.filter(([m]) => enabled.includes(m));
  if (available.length === 0) return "cash";
  return rng.weighted(available);
}

/** Troco: entrega um valor "redondo" maior ou igual ao total. */
function cashReceived(amount: number): number {
  const step = rng.pick([10, 20, 50]);
  const rounded = Math.ceil(amount / step) * step;
  if (rounded > amount) return round2(rounded);
  return round2(rng.chance(0.5) ? amount : amount + step);
}

function buildPayments(total: number, enabled: PayMethod[]): { payments: PlanPayment[]; paymentMethod: PayMethod | null } {
  const split = total >= 25 && enabled.length > 1 && rng.chance(0.18);
  if (!split) {
    const method = pickMethod(enabled);
    const received = method === "cash" ? cashReceived(total) : null;
    return {
      payments: [{ method, amount: total, received, change: received === null ? null : round2(received - total) }],
      paymentMethod: method,
    };
  }
  // Pagamento fracionado: duas linhas que somam exatamente o total (regra do
  // fechamento: soma == total, todas confirmed).
  const first = pickMethod(enabled);
  const rest = enabled.filter((m) => m !== first);
  const second = rng.pick(rest);
  const amountFirst = round2((total * rng.int(3, 7)) / 10);
  const amountSecond = round2(total - amountFirst);
  if (amountFirst <= 0 || amountSecond <= 0) return buildPayments(total, [first]);
  const received = first === "cash" ? cashReceived(amountFirst) : null;
  return {
    payments: [
      { method: first, amount: amountFirst, received, change: received === null ? null : round2(received - amountFirst) },
      { method: second, amount: amountSecond, received: null, change: null },
    ],
    paymentMethod: null, // denormalizado só quando há um único método
  };
}

function buildDelivery(args: {
  address: string;
  status: PlanDelivery["status"];
  openedAt: string;
  closedAt: string;
  courierId: string | null;
}): PlanDelivery {
  const distanceKm = round2(rng.float() * 5.5 + 0.8);
  const dispatchedAt = isoMinus(args.closedAt, rng.int(8, 40));
  return {
    address: args.address,
    distanceKm,
    estimatedMinutes: Math.round(distanceKm * 4 + 12),
    status: args.status,
    courierId: args.status === "awaiting_courier" ? null : args.courierId,
    dispatchedAt: args.status === "awaiting_courier" ? null : dispatchedAt,
    deliveredAt: args.status === "delivered" ? isoMinus(args.closedAt, rng.int(0, 7)) : null,
    notes: null,
  };
}

function formatAddress(a: AddrRow): string {
  const complement = a.complement ? ` - ${a.complement}` : "";
  const state = a.state ? ` - ${a.state}` : "";
  return `${a.street}, ${a.number}${complement} - ${a.neighborhood}, ${a.city}${state}`;
}

// ------------------------------------------------------------
// Histórico: 30 dias, densidade maior nos recentes + fim de semana
// ------------------------------------------------------------
function ordersForDay(daysAgo: number): number {
  const recentness = (31 - daysAgo) / 30; // 1.00 (ontem) → 0.03 (há 30 dias)
  let n = 3 + Math.round(recentness * 4); // 7 → 3 comandas
  const dow = dayStartUtc(daysAgo).getUTCDay();
  if (dow === 5 || dow === 6) n += 2; // sexta e sábado movimentam mais
  return n;
}

function buildHistoryOrder(args: {
  key: string; // hist-07-03
  daysAgo: number;
  status: "closed" | "cancelled";
  ctx: Ctx;
}): PlanOrder {
  const { key, daysAgo, ctx } = args;
  const isCancelled = args.status === "cancelled";
  const roll = rng.float();

  // identificação (chk_order_identification_required): mesa, tab ou delivery
  let tableId: string | null = null;
  let tableNumber: string | null = null;
  let tabLabel: string | null = null;
  let customerId: string | null = null;
  let customerName: string | null = null;
  let channel: PlanOrder["channel"] = "balcao";
  let address: AddrRow | null = null;

  if (isCancelled) {
    // cancelamento no salão: mesa ou balcão (nunca delivery)
    if (roll < 0.65 && ctx.tables.length > 0) {
      const t = rng.pick(ctx.tables);
      tableId = t.id;
      tableNumber = t.number;
    } else {
      tabLabel = rng.pick(TAB_LABELS);
    }
  } else if (roll < 0.62 && ctx.tables.length > 0) {
    const t = rng.pick(ctx.tables);
    tableId = t.id;
    tableNumber = t.number;
  } else if (roll < 0.82 || ctx.addresses.length === 0) {
    tabLabel = rng.pick(TAB_LABELS);
  } else {
    address = rng.pick(ctx.addresses);
    customerId = address.customerId;
    customerName = address.customerName;
    tabLabel = `Delivery - ${customerName}`; // mesmo formato do order-intake
    channel = "web";
  }

  const openedAt = isoOnDay(daysAgo, rng.int(14, 21), rng.int(0, 59));
  // fechamento sempre DENTRO do mesmo dia calendário (relatório agrupa por dia)
  const closedAt = isCancelled
    ? null
    : new Date(Math.min(Date.parse(isoPlus(openedAt, rng.int(20, 150))), Date.parse(isoOnDay(daysAgo, 23, 30)))).toISOString();

  const waiterId = rng.chance(0.6) ? ctx.people.ana : ctx.people.carlos;
  const items = buildItems(ctx.catalog, isCancelled);
  const deliveryFee = address ? ctx.fee : null;

  const delivery = address
    ? buildDelivery({
        address: formatAddress(address),
        status: rng.chance(0.92) ? "delivered" : "failed",
        openedAt,
        closedAt: closedAt!,
        courierId: ctx.people.entregador,
      })
    : null;

  const payments = isCancelled
    ? { payments: [] as PlanPayment[], paymentMethod: null as PayMethod | null }
    : buildPayments(orderItemsTotal({ items, deliveryFee }), ctx.enabled);

  return {
    key,
    id: `demo-${key}`,
    status: isCancelled ? "cancelled" : "closed",
    tableId,
    tableNumber,
    tabLabel,
    customerId,
    customerName,
    channel,
    waiterId,
    openedAt,
    closedAt,
    cancelReason: isCancelled ? rng.pick(CANCEL_REASONS) : null,
    deliveryFee,
    notes: rng.chance(0.1) ? rng.pick(ORDER_NOTES) : null,
    items,
    payments: payments.payments,
    paymentMethod: payments.paymentMethod,
    paymentConfirmedAt: closedAt, // histórico: sempre confirmado no fechamento
    paymentConfirmedBy: isCancelled ? null : ctx.people.caixa,
    delivery,
    alertReadAt: closedAt ?? isoPlus(openedAt, 10),
  };
}

// ------------------------------------------------------------
// Comandas ABERTAS de hoje — 15 casos cobrindo todos os estados da cozinha,
// pagamentos pendentes/confirmados e entregas em andamento. Produtos nomeados
// de propósito (a tela da cozinha fica legível); se um nome não existir no
// catálogo do banco alvo, cai no sorteio ponderado.
// ------------------------------------------------------------
type OpenItemSpec = { product: string; qty: number; status: ItemStatus; notes?: string | null };

type OpenSpec = {
  suffix: string;
  kind: "table" | "tab" | "delivery";
  tableIndex?: number; // índice em ctx.tables (mesas livres)
  tabLabel?: string;
  channel?: "web";
  addressIndex?: number;
  minutesAgo: number;
  waiter: "ana" | "carlos" | "system";
  items: OpenItemSpec[];
  payment?: { method: PayMethod; confirmedMinutesAgo?: number }; // sem linha = sem pagamento
  cancelReason?: string;
  deliveryStatus?: PlanDelivery["status"];
  deliveryCourier?: boolean;
  // Índice em `ctx.couriers` do motoboy atribuído (default 0). Só tem efeito
  // quando `deliveryCourier` é true; é o que espalha as entregas em rota entre
  // os 3 entregadores para o mapa mostrar mais de um marker.
  courierIndex?: number;
  notes?: string | null;
};

const OPEN_SPECS: OpenSpec[] = [
  // 01 — recém-aberta, cozinha ainda não começou
  { suffix: "01", kind: "table", tableIndex: 0, minutesAgo: 15, waiter: "ana",
    items: [ { product: "X-Burger", qty: 2, status: "ordered" }, { product: "Chopp 300ml", qty: 2, status: "ordered" }, { product: "Batata frita", qty: 1, status: "ordered" } ] },
  // 02 — cozinha entregou parte, parte ainda ordered
  { suffix: "02", kind: "table", tableIndex: 1, minutesAgo: 40, waiter: "carlos",
    items: [ { product: "Picanha na Chapa", qty: 1, status: "ready" }, { product: "Refrigerante Lata", qty: 2, status: "ready" }, { product: "Pudim de Leite", qty: 1, status: "ordered" } ] },
  // 03 — tudo pronto, garçom ainda não serviu
  { suffix: "03", kind: "table", tableIndex: 2, minutesAgo: 70, waiter: "ana", notes: "Aniversário — levar vela",
    items: [ { product: "Lasanha à Bolonhesa", qty: 2, status: "ready" }, { product: "Refrigerante Lata", qty: 2, status: "ready" } ] },
  // 04 — servida, aguardando fechamento (sem pagamento lançado)
  { suffix: "04", kind: "table", tableIndex: 3, minutesAgo: 90, waiter: "carlos",
    items: [ { product: "X-Burger", qty: 1, status: "delivered" }, { product: "Chopp 300ml", qty: 2, status: "delivered" } ] },
  // 05 — servida, intenção de Pix NÃO confirmada
  { suffix: "05", kind: "table", tableIndex: 4, minutesAgo: 120, waiter: "ana",
    items: [ { product: "Picanha na Chapa", qty: 1, status: "delivered" }, { product: "Cerveja Long Neck", qty: 2, status: "delivered" }, { product: "Batata frita", qty: 1, status: "delivered" } ],
    payment: { method: "pix" } },
  // 06 — balcão recém-aberto
  { suffix: "06", kind: "tab", tabLabel: "Balcão 01", minutesAgo: 20, waiter: "carlos",
    items: [ { product: "Chopp 300ml", qty: 2, status: "ordered" }, { product: "Isca de peixe", qty: 1, status: "ordered" } ] },
  // 07 — balcão servido, dinheiro entregue mas não confirmado (troco calculado)
  { suffix: "07", kind: "tab", tabLabel: "Retirada · Balcão", minutesAgo: 60, waiter: "ana",
    items: [ { product: "X-Burger", qty: 2, status: "delivered" }, { product: "Refrigerante Lata", qty: 2, status: "delivered" } ],
    payment: { method: "cash" } },
  // 08 — delivery web, cozinha pronta, sem entregador atribuído
  { suffix: "08", kind: "delivery", channel: "web", addressIndex: 0, minutesAgo: 25, waiter: "system",
    items: [ { product: "Pizza Margherita", qty: 1, status: "ready" }, { product: "Refrigerante Lata", qty: 2, status: "ready" } ],
    deliveryStatus: "awaiting_courier" },
  // 09 — delivery a caminho, cartão pendente de confirmação
  { suffix: "09", kind: "delivery", channel: "web", addressIndex: 1, minutesAgo: 80, waiter: "system",
    items: [ { product: "Feijoada Completa", qty: 1, status: "delivered" }, { product: "Suco Natural 500ml", qty: 1, status: "delivered" } ],
    payment: { method: "card" }, deliveryStatus: "out_for_delivery", deliveryCourier: true, courierIndex: 0 },
  // 10 — delivery entregue, Pix ainda não caiu
  { suffix: "10", kind: "delivery", channel: "web", addressIndex: 2, minutesAgo: 150, waiter: "system",
    items: [ { product: "Combo Casal", qty: 1, status: "delivered" }, { product: "Mojito", qty: 2, status: "delivered" } ],
    payment: { method: "pix" }, deliveryStatus: "delivered", deliveryCourier: true, courierIndex: 1 },
  // 11 — cancelada hoje (salão)
  { suffix: "11", kind: "table", tableIndex: 5, minutesAgo: 30, waiter: "ana", cancelReason: "Cliente desistiu",
    items: [ { product: "Calabresa Acebolada", qty: 1, status: "cancelled", notes: "Cancelado pelo garçom" } ] },
  // 12 — paga e servida, caixa ainda não fechou a conta
  { suffix: "12", kind: "table", tableIndex: 6, minutesAgo: 200, waiter: "carlos",
    items: [ { product: "Frango à Passarinho", qty: 1, status: "delivered" }, { product: "Cerveja Artesanal IPA 500ml", qty: 2, status: "delivered" }, { product: "Brownie com Sorvete", qty: 1, status: "delivered" } ],
    payment: { method: "card", confirmedMinutesAgo: 10 } },
  // 13 — delivery a caminho (2º motoboy)
  { suffix: "13", kind: "delivery", channel: "web", addressIndex: 3, minutesAgo: 45, waiter: "system",
    items: [ { product: "Picanha na Chapa", qty: 1, status: "delivered" }, { product: "Cerveja Long Neck", qty: 2, status: "delivered" } ],
    payment: { method: "cash" }, deliveryStatus: "out_for_delivery", deliveryCourier: true, courierIndex: 1 },
  // 14 — delivery a caminho (3º motoboy)
  { suffix: "14", kind: "delivery", channel: "web", addressIndex: 4, minutesAgo: 35, waiter: "system",
    items: [ { product: "Pizza Margherita", qty: 1, status: "delivered" }, { product: "Refrigerante Lata", qty: 1, status: "delivered" } ],
    payment: { method: "pix" }, deliveryStatus: "out_for_delivery", deliveryCourier: true, courierIndex: 2 },
  // 15 — delivery aguardando entregador, sem atribuição (mais um pedido no mapa)
  { suffix: "15", kind: "delivery", channel: "web", addressIndex: 5, minutesAgo: 12, waiter: "system",
    items: [ { product: "X-Burger", qty: 1, status: "ordered" }, { product: "Batata frita", qty: 1, status: "ordered" } ],
    deliveryStatus: "awaiting_courier" },
];

function buildOpenOrders(ctx: Ctx): PlanOrder[] {
  const nowIso = new Date().toISOString();
  const todayFloor = dayStartUtc(0).getTime() + 5 * 60_000; // nunca antes de 00:05Z
  const orders: PlanOrder[] = [];

  for (const spec of OPEN_SPECS) {
    const key = `open-${spec.suffix}`;
    let tableId: string | null = null;
    let tableNumber: string | null = null;
    let tabLabel: string | null = spec.tabLabel ?? null;
    let customerId: string | null = null;
    let customerName: string | null = null;
    let channel: PlanOrder["channel"] = spec.channel ?? "balcao";
    let address: AddrRow | null = null;

    if (spec.kind === "table" && ctx.tables.length > 0) {
      const t = ctx.tables[spec.tableIndex! % ctx.tables.length]!;
      tableId = t.id;
      tableNumber = t.number;
      tabLabel = null;
    } else if (spec.kind === "delivery" && ctx.addresses.length > 0) {
      address = ctx.addresses[spec.addressIndex! % ctx.addresses.length]!;
      customerId = address.customerId;
      customerName = address.customerName;
      tabLabel = `Delivery - ${customerName}`;
    } else if (!tabLabel) {
      tabLabel = rng.pick(TAB_LABELS); // sem mesas/endereços disponíveis: vira balcão
    }

    const openedAt = new Date(Math.max(Date.now() - spec.minutesAgo * 60_000, todayFloor)).toISOString();
    const waiterId = spec.waiter === "ana" ? ctx.people.ana : spec.waiter === "carlos" ? ctx.people.carlos : ctx.people.system;
    const deliveryFee = address ? ctx.fee : null;

    const items: PlanItem[] = spec.items.map((it) => {
      const product = ctx.catalogByName.get(it.product) ?? pickProduct(ctx.catalog);
      const transitionMin =
        it.status === "ready" ? Math.min(spec.minutesAgo, 12) : it.status === "delivered" ? Math.min(spec.minutesAgo, 40) : 0;
      const updatedAt =
        it.status === "cancelled" ? isoMinus(nowIso, 3) : transitionMin > 0 ? isoPlus(openedAt, transitionMin) : openedAt;
      return {
        productId: product.id,
        quantity: it.qty,
        unitPrice: product.price,
        costPrice: product.costPrice,
        status: it.status,
        selectedVariations: pickVariationSelection(product),
        notes: it.notes ?? null,
        version: versionFor(it.status),
        updatedAt,
      };
    });

    let payments: PlanPayment[] = [];
    let paymentMethod: PayMethod | null = null;
    let paymentConfirmedAt: string | null = null;
    let paymentConfirmedBy: string | null = null;
    if (spec.payment && spec.cancelReason === undefined) {
      const total = orderItemsTotal({ items, deliveryFee });
      const method = spec.payment.method;
      const received = method === "cash" ? cashReceived(total) : null;
      payments = [{ method, amount: total, received, change: received === null ? null : round2(received - total) }];
      paymentMethod = method;
      if (spec.payment.confirmedMinutesAgo !== undefined) {
        paymentConfirmedAt = isoMinus(nowIso, spec.payment.confirmedMinutesAgo);
        paymentConfirmedBy = ctx.people.caixa;
      }
    }

    let delivery: PlanDelivery | null = null;
    if (address && spec.deliveryStatus) {
      const status = spec.deliveryStatus;
      delivery = {
        address: formatAddress(address),
        distanceKm: round2(rng.float() * 5.5 + 0.8),
        estimatedMinutes: 0,
        status,
        courierId: spec.deliveryCourier
          ? (ctx.couriers[spec.courierIndex ?? 0] ?? ctx.people.entregador)
          : null,
        dispatchedAt: status === "awaiting_courier" ? null : isoPlus(openedAt, Math.min(spec.minutesAgo, 15)),
        deliveredAt: status === "delivered" ? isoMinus(nowIso, 5) : null,
        notes: null,
      };
      delivery.estimatedMinutes = Math.round(delivery.distanceKm * 4 + 12);
    }

    orders.push({
      key,
      id: `demo-${key}`,
      status: spec.cancelReason ? "cancelled" : "open",
      tableId,
      tableNumber,
      tabLabel,
      customerId,
      customerName,
      channel,
      waiterId,
      openedAt,
      closedAt: null,
      cancelReason: spec.cancelReason ?? null,
      deliveryFee,
      notes: spec.notes ?? null,
      items,
      payments,
      paymentMethod,
      paymentConfirmedAt,
      paymentConfirmedBy,
      delivery,
      // não lido (sino com badge) em toda comanda aberta ativa; a cancelada
      // de hoje já foi vista por alguém (é o que motivou o cancelamento)
      alertReadAt: spec.cancelReason ? isoMinus(nowIso, 5) : null,
    });
  }
  return orders;
}

// ------------------------------------------------------------
// Gavetas: uma por dia histórico (fechada) + a de hoje (aberta).
// Esperado = fundo inicial + vendas em dinheiro confirmadas na janela
// + suprimentos − sangrias (mesma fórmula de computeCashSummary).
// ------------------------------------------------------------
function buildHistoryDrawer(daysAgo: number, dayOrders: PlanOrder[], people: People): PlanDrawer {
  const openedAt = isoOnDay(daysAgo, 13, 0);
  const closedAt = isoOnDay(daysAgo, 23, 59);
  const opening = 200;
  const cashSales = round2(
    dayOrders.reduce(
      (sum, o) => sum + o.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0),
      0,
    ),
  );
  const dd = pad2(daysAgo);
  const movements: PlanDrawerMovement[] = [];
  let balance = opening + cashSales;

  if (rng.chance(0.55)) {
    const amount = Math.min(rng.int(5, 12) * 10, balance - 100);
    if (amount >= 50) {
      movements.push({
        id: `demo-cdm-${dd}-01`,
        type: "sangria",
        amount,
        note: "Retirada de troco do salão",
        createdAt: isoOnDay(daysAgo, rng.int(16, 22), rng.int(0, 59)),
      });
      balance -= amount;
    }
  }
  if (rng.chance(0.4)) {
    const amount = rng.int(5, 20) * 10;
    movements.push({
      id: `demo-cdm-${dd}-${pad2(movements.length + 1)}`,
      type: "suprimento",
      amount,
      note: "Reforço de troco",
      createdAt: isoOnDay(daysAgo, rng.int(14, 20), rng.int(0, 59)),
    });
    balance += amount;
  }

  const manual = movements.reduce((acc, m) => acc + (m.type === "sangria" ? -m.amount : m.amount), 0);
  const expected = round2(opening + cashSales + manual);
  const diff = rng.pick([-2, -1, 0, 0, 0, 1, 2]);

  return {
    id: `demo-drawer-d${dd}`,
    openedAt,
    openedBy: people.caixa,
    openingAmount: opening,
    closedAt,
    closedBy: people.caixa,
    closingExpected: expected,
    closingCounted: round2(expected + diff),
    closingDifference: diff,
    closingNote: diff === 0 ? null : "Diferença de conferência",
    movements,
  };
}

function buildTodayDrawer(people: People): PlanDrawer {
  const floor = dayStartUtc(0).getTime();
  const openedAt = new Date(Math.max(Date.now() - 400 * 60_000, floor)).toISOString();
  return {
    id: "demo-drawer-today",
    openedAt,
    openedBy: people.caixa,
    openingAmount: 200,
    closedAt: null,
    closedBy: null,
    closingExpected: null,
    closingCounted: null,
    closingDifference: null,
    closingNote: null,
    movements: [],
  };
}

// ------------------------------------------------------------
// Plano completo: dias 30→1 (mais antigo primeiro, para o `seq` do ledger ser
// um replay cronológico) + o dia de hoje por último (comandas abertas).
// ------------------------------------------------------------
export function buildPlan(ctx: Ctx): PlanDay[] {
  const days: PlanDay[] = [];
  for (let d = 30; d >= 1; d--) {
    const orders: PlanOrder[] = [];
    const n = ordersForDay(d);
    for (let i = 1; i <= n; i++) {
      const status = rng.chance(0.045) ? "cancelled" : "closed";
      orders.push(buildHistoryOrder({ key: `hist-${pad2(d)}-${pad2(i)}`, daysAgo: d, status, ctx }));
    }
    days.push({ daysAgo: d, orders, drawer: buildHistoryDrawer(d, orders, ctx.people), isToday: false });
  }
  days.push({ daysAgo: 0, orders: buildOpenOrders(ctx), drawer: buildTodayDrawer(ctx.people), isToday: true });
  return days;
}
