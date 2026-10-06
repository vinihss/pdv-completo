// ============================================================
// Seed de DEMONSTRAÇÃO com volume — `npm run seed:demo`
// (wrapper da raiz: `./pdv db seed-demo`).
//
// O que é: banco de teste COMPLETO e com volume para exercitar a aplicação
// inteira — relatórios e gráficos por período (~30 dias de histórico),
// listagens, comandas em todos os estágios da cozinha, estoque (ledger),
// gaveta de caixa e entregas. Ele roda POR CIMA do seed base
// (`runBaseSeed()`, o mesmo do `npm run seed`): num banco novo ele primeiro
// cria migrations + dados base (store_settings, usuários, catálogo inicial,
// mesas) e só depois acrescenta o demo — ou seja, `npm run seed:demo` sozinho
// já basta num banco vazio.
//
// Idempotência / marcação do demo
// -------------------------------
// TODA linha criada aqui tem PK com prefixo `demo-` — o mesmo critério de ids
// determinísticos do cardápio Unami (`p-unami-*`), que já é precedente no repo:
//
//   demo-hist-07-03     comanda histórica (dia 7 atrás, nº 03)
//   demo-open-01        1ª comanda aberta de hoje
//   demo-oi-hist-07-03-01 / demo-pay-… / demo-sm-…   filhos da comanda
//   demo-p-brownie, demo-cat-cocktails, demo-cust-12, demo-addr-03
//   demo-drawer-d07, demo-drawer-today, demo-cdm-…   gavetas e movimentos
//   demo-del-…        entregas · demo-alert-… · demo-a-… (audit_log)
//
// A marca de "já rodei" é a própria existência dessas linhas:
//   1. todo INSERT usa `ON CONFLICT DO NOTHING`;
//   2. os filhos (itens, pagamentos, movimentos de estoque, entrega, alertas,
//      auditoria) só são gravados para as comandas que o INSERT do bloco
//      devolveu de volta — ou seja, para as que foram realmente NOVAS.
// Cada dia de histórico é uma transação atômica, então uma execução
// interrompida no meio deixa dias completos + dias ausentes, e a reexecução
// completa os que faltam sem duplicar os existentes. Rodar 2× é sempre seguro
// (a 2ª só reporta "0 novas"). A última linha gravada é o marcador final
// `demo-a-seed` (ação `seed_demo` no audit_log): se ele existe, a execução
// anterior terminou.
//
// Para LIMPAR o demo de um banco de teste (ordem respeita as FKs):
//
//   BEGIN;
//   DELETE FROM alert                WHERE id LIKE 'demo-%';
//   DELETE FROM stock_movement       WHERE id LIKE 'demo-%';
//   DELETE FROM cash_drawer_movement WHERE id LIKE 'demo-%';
//   DELETE FROM cash_drawer          WHERE id LIKE 'demo-%';
//   DELETE FROM delivery             WHERE id LIKE 'demo-%';
//   DELETE FROM audit_log            WHERE id LIKE 'demo-%';
//   DELETE FROM order_payment        WHERE id LIKE 'demo-%';
//   DELETE FROM order_item           WHERE id LIKE 'demo-%';
//   DELETE FROM "order"              WHERE id LIKE 'demo-%';
//   DELETE FROM customer_address     WHERE id LIKE 'demo-%';
//   DELETE FROM customer             WHERE id LIKE 'demo-%';
//   DELETE FROM product              WHERE id LIKE 'demo-%';
//   DELETE FROM category             WHERE id LIKE 'demo-%';
//   DELETE FROM kitchen_group        WHERE id LIKE 'demo-%';
//   UPDATE restaurant_table SET status = 'free' WHERE status = 'occupied';
//   COMMIT;
//
//   (o `store_settings.delivery_fee` que este seed completa para 7,90 NÃO é
//    revertido — é ajuste de configuração, não dado de demonstração)
//
// Decisão sobre outbox: aqui NÃO gravamos `outbox_event`. O AGENTS.md exige
// audit + outbox na MESMA transação da escrita de domínio da APLICAÇÃO, porque
// a tela precisa saber na hora; este script escreve dados que as telas leem
// via REST (recarregamento manual), então milhares de eventos "não publicados"
// de um seed antigo só poluiriam o dispatcher no boot de um banco de teste.
// O `audit_log`, sim, é populado com as mesmas ações que a aplicação grava
// (order_opened, payment_registered, order_closed, order_cancelled,
// cash_drawer_opened/closed/sangria/suprimento, delivery_created/completed)
// porque a tela de Auditoria é dado que se lê — é a mesma régua: completo o
// que a TELA mostra, parcial o que é ruído interno.
//
// Cancelamento e estoque: comanda/item cancelado NÃO escreve movimento no
// ledger — o efeito líquido de "venda + estorno" do app é zero, e omitir os
// dois deltas deixa o `seq` do ledger sem ruído. O saldo final é invariante:
// SUM(quantity_delta) por produto rastreado == alvo calculado em
// `ensureInitialAdjustments` (>= 0 sempre; três produtos ficam abaixo do
// threshold de propósito, para a tela de Estoque já nascer com alerta).
// ============================================================
import { asc, eq, sql } from "drizzle-orm";
import { closeDatabase, db, type Tx } from "./client.js";
import { runBaseSeed } from "./seed-base.js";
import { round2 } from "../../domain/money.js";
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
} from "./schema.js";

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

const pad2 = (n: number) => String(n).padStart(2, "0");

// ------------------------------------------------------------
// Datas: os timestamps do schema são text ISO-8601 UTC, e os relatórios
// agrupam por dia LOCAL da loja (offset do cliente). Para o mesmo evento cair
// no MESMO dia calendário com tz=0 (default do backend) e com -03:00 (BR),
// todo o histórico é gerado entre 14:00Z e 22:59Z — 11h às 19h30 em Brasília.
// Nada é gerado para "hoje" de propósito: dependendo do horário da execução,
// hoje ainda tem o dia inteiro pela frente e uma venda futura é ruim.
// ------------------------------------------------------------
function dayStartUtc(daysAgo: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

function isoOnDay(daysAgo: number, hour: number, minute: number): string {
  const d = dayStartUtc(daysAgo);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

function isoMinus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

function isoPlus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

// ------------------------------------------------------------
// Catálogo demo (além dos 6 produtos do seed base). Categorias e grupos de
// cozinha novos entram junto; ids determinísticos `demo-*`.
// ------------------------------------------------------------
type VariationDef = { name: string; options: string[]; required?: boolean };

type ProductDef = {
  slug: string;
  name: string;
  description: string;
  category: string; // nome (base ou demo)
  group: string; // nome (base ou demo)
  price: number;
  cost: number;
  track?: boolean;
  threshold?: number;
  unit?: string;
  weight: number; // peso no sorteio de itens das comandas
  featured?: boolean;
  variations?: VariationDef[];
};

const DEMO_CATEGORIES = [
  { id: "demo-cat-cocktails", name: "Cocktails", displayOrder: 4 },
  { id: "demo-cat-sobremesas", name: "Sobremesas", displayOrder: 5 },
  { id: "demo-cat-entradas", name: "Entradas", displayOrder: 6 },
];

const DEMO_KITCHEN_GROUPS = [
  { id: "demo-kg-forno", name: "Forno", displayOrder: 4 },
  { id: "demo-kg-doces", name: "Doces", displayOrder: 5 },
];

const DEMO_PRODUCTS: ProductDef[] = [
  // ---- Bebidas ----
  { slug: "refrigerante-lata", name: "Refrigerante Lata", description: "Coca, Guaraná ou Sprite 350ml", category: "Bebidas", group: "Bar", price: 7, cost: 2.4, unit: "lata", weight: 4 },
  { slug: "agua-mineral", name: "Água Mineral 500ml", description: "Com ou sem gás", category: "Bebidas", group: "Bar", price: 5, cost: 1.4, unit: "garrafa", weight: 2 },
  { slug: "suco-natural", name: "Suco Natural 500ml", description: "Laranja, limão ou maracujá", category: "Bebidas", group: "Bar", price: 12, cost: 4.5, unit: "copo", weight: 2, variations: [{ name: "Fruta", options: ["Laranja", "Limão", "Maracujá"] }] },
  { slug: "cerveja-ipa", name: "Cerveja Artesanal IPA 500ml", description: "IPA da casa, garrafa 500ml", category: "Bebidas", group: "Bar", price: 22, cost: 9, track: true, threshold: 24, unit: "garrafa", weight: 3 },
  { slug: "cerveja-long-neck", name: "Cerveja Long Neck", description: "Amber lager 355ml", category: "Bebidas", group: "Bar", price: 12, cost: 5.5, track: true, threshold: 36, unit: "un", weight: 4 },
  { slug: "vinho-taca", name: "Vinho da Taça (Merlot)", description: "Taça 150ml", category: "Bebidas", group: "Bar", price: 16, cost: 6, unit: "taça", weight: 1 },

  // ---- Pratos ----
  { slug: "picanha", name: "Picanha na Chapa", description: "300g com farofa e vinagrete", category: "Pratos", group: "Grelha", price: 68, cost: 32, track: true, threshold: 6, unit: "porção", weight: 1, featured: true },
  { slug: "frango-passarinho", name: "Frango à Passarinho", description: "Porção com alho e limão", category: "Pratos", group: "Grelha", price: 38, cost: 14, unit: "porção", weight: 2 },
  { slug: "lasanha", name: "Lasanha à Bolonhesa", description: "Individual, molho da casa", category: "Pratos", group: "Forno", price: 36, cost: 13, track: true, threshold: 8, unit: "porção", weight: 2 },
  { slug: "salmao", name: "Salmão Grelhado", description: "Com legumes e limão", category: "Pratos", group: "Grelha", price: 58, cost: 26, track: true, threshold: 6, unit: "porção", weight: 1 },
  { slug: "risoto", name: "Risoto de Cogumelos", description: "Cremoso, com parmesão", category: "Pratos", group: "Cozinha", price: 44, cost: 17, unit: "porção", weight: 1 },
  { slug: "pizza-margherita", name: "Pizza Margherita", description: "Individual, muçarela e manjericão", category: "Pratos", group: "Forno", price: 48, cost: 16, unit: "un", weight: 1 },
  { slug: "feijoada", name: "Feijoada Completa", description: "Arroz, couve, farofa e laranja", category: "Pratos", group: "Cozinha", price: 42, cost: 15, unit: "porção", weight: 1 },
  { slug: "combo-casal", name: "Combo Casal", description: "2 chopp 300ml + porção de batata", category: "Pratos", group: "Grelha", price: 55, cost: 24, weight: 1, featured: true, variations: [{ name: "Acompanhamento", options: ["Batata rústica", "Farofa", "Vinagrete"], required: true }] },

  // ---- Porções ----
  { slug: "calabresa-acebolada", name: "Calabresa Acebolada", description: "Porção com cebola e vinagrete", category: "Porções", group: "Cozinha", price: 32, cost: 12, unit: "porção", weight: 2 },
  { slug: "mandioca-frita", name: "Mandioca Frita", description: "Com manteiga e salsa", category: "Porções", group: "Cozinha", price: 24, cost: 8, unit: "porção", weight: 2 },
  { slug: "onion-rings", name: "Onion Rings", description: "Anéis de cebola empanados", category: "Porções", group: "Cozinha", price: 26, cost: 9, track: true, threshold: 10, unit: "porção", weight: 1 },
  { slug: "bolinho-bacalhau", name: "Bolinho de Bacalhau (6un)", description: "Unidades crocantes", category: "Porções", group: "Cozinha", price: 34, cost: 15, track: true, threshold: 10, unit: "un", weight: 2 },
  { slug: "torresmo-rol", name: "Torresmo de Rolo", description: "Porção com limão", category: "Porções", group: "Cozinha", price: 30, cost: 11, unit: "porção", weight: 2 },
  { slug: "camarao-empanado", name: "Camarão Empanado", description: "12 unidades com molho tártaro", category: "Porções", group: "Cozinha", price: 52, cost: 24, track: true, threshold: 6, unit: "porção", weight: 1 },

  // ---- Entradas ----
  { slug: "tabua-frios", name: "Tábua de Frios", description: "Queijos, presunto e compota", category: "Entradas", group: "Cozinha", price: 46, cost: 20, unit: "tábua", weight: 1 },
  { slug: "bruschetta", name: "Bruschetta (4un)", description: "Tomate, manjericão e alho", category: "Entradas", group: "Forno", price: 24, cost: 8, unit: "un", weight: 1 },
  { slug: "pastel-queijo", name: "Pastel de Queijo (4un)", description: "Massa crocante com muçarela", category: "Entradas", group: "Cozinha", price: 22, cost: 8, track: true, threshold: 12, unit: "un", weight: 2 },

  // ---- Cocktails ----
  { slug: "caipirinha-maracuja", name: "Caipirinha de Maracujá", description: "Cachaça, fruta e açúcar", category: "Cocktails", group: "Bar", price: 22, cost: 7, weight: 2, variations: [{ name: "Fruta", options: ["Maracujá", "Limão", "Morango"] }] },
  { slug: "pina-colada", name: "Piña Colada", description: "Rum, coco e abacaxi", category: "Cocktails", group: "Bar", price: 26, cost: 9, weight: 1 },
  { slug: "margarita", name: "Margarita", description: "Tequila, limão e triple sec", category: "Cocktails", group: "Bar", price: 27, cost: 9.5, weight: 1, variations: [{ name: "Servir", options: ["Clássica", "Com borda de sal"] }] },
  { slug: "espresso-martini", name: "Espresso Martini", description: "Vodka, café e licor", category: "Cocktails", group: "Bar", price: 29, cost: 10, weight: 1 },
  { slug: "old-fashioned", name: "Old Fashioned", description: "Bourbon, açúcar e angostura", category: "Cocktails", group: "Bar", price: 32, cost: 12, weight: 1 },
  { slug: "mojito", name: "Mojito", description: "Rum, hortelã e limão", category: "Cocktails", group: "Bar", price: 24, cost: 8, weight: 2, variations: [{ name: "Fruta", options: ["Limão", "Maracujá", "Morango"] }] },

  // ---- Sobremesas ----
  { slug: "pudim", name: "Pudim de Leite", description: "Fatia com calda de caramelo", category: "Sobremesas", group: "Doces", price: 14, cost: 4, track: true, threshold: 10, unit: "fatia", weight: 2 },
  { slug: "brownie", name: "Brownie com Sorvete", description: "Quente com bola de creme", category: "Sobremesas", group: "Doces", price: 18, cost: 6, track: true, threshold: 10, unit: "un", weight: 2, featured: true },
  { slug: "petit-gateau", name: "Petit Gâteau", description: "Chocolate quente com sorvete", category: "Sobremesas", group: "Forno", price: 22, cost: 8, unit: "un", weight: 1 },
  { slug: "acai-tigela", name: "Açaí na Tigela 500ml", description: "Com banana e granola", category: "Sobremesas", group: "Doces", price: 24, cost: 9, track: true, threshold: 8, unit: "tigela", weight: 1 },
];

// Produtos do seed BASE entram no sorteio com estes pesos (os ids deles são
// UUID gerados pelo próprio base, por isso o mapa é por NOME).
const BASE_WEIGHTS: Record<string, number> = {
  "Chopp 300ml": 5,
  "Caipirinha": 3,
  "X-Burger": 4,
  "Filé à parmegiana": 2,
  "Batata frita": 3,
  "Isca de peixe": 1,
};

// Produtos rastreados que terminam ABAIXO do threshold para a tela de Estoque
// já nascer com item em alerta (a base já deixa "Batata frita" baixa).
const LOW_STOCK_TARGETS: Record<string, number> = {
  "Batata frita": 9, // threshold 15
  "Cerveja Long Neck": 22, // threshold 36
  "Pudim de Leite": 6, // threshold 10
};

// ------------------------------------------------------------
// Clientes: 40 nomes + 16 com endereço (bom para delivery).
// Nada aqui consome o RNG do plano — números/fones são fórmulas puras, para
// que a ordem de construção do plano seja idêntica em qualquer execução.
// ------------------------------------------------------------
const CUSTOMER_NAMES = [
  "Mariana Souza", "Rafael Oliveira", "Juliana Pereira", "Bruno Santos", "Camila Rodrigues",
  "Diego Almeida", "Fernanda Lima", "Gustavo Costa", "Helena Martins", "Igor Ferreira",
  "Larissa Alves", "Marcelo Ribeiro", "Natália Barbosa", "Otávio Cardoso", "Patrícia Gomes",
  "Renato Dias", "Sabrina Machado", "Thiago Araújo", "Vanessa Correia", "Wesley Moreira",
  "Amanda Teixeira", "Caio Figueiredo", "Débora Nunes", "Eduardo Pinto", "Flávia Carvalho",
  "Giovanni Roveri", "Isabela Monteiro", "João Pedro Braga", "Karina Freitas", "Lucas Tavares",
  "Mirela Antunes", "Nelson Batista", "Olívia Ramalho", "Paulo Sérgio Melo", "Queila Duarte",
  "Ricardo Assunção", "Simone Xavier", "Tiago Albuquerque", "Ubiratã Lopes", "Vitória Sampaio",
];

const STREETS = [
  "Rua das Palmeiras", "Av. Brasil", "Rua Augusta", "Rua Joaquim Nabuco", "Av. Paulista",
  "Rua dos Pinheiros", "Rua Sete de Setembro", "Rua do Comércio", "Av. Independência",
  "Rua Bela Cintra", "Rua Haddock Lobo", "Rua Consolação", "Rua Minas Gerais",
  "Rua Tabapuã", "Av. Rebouças", "Rua Oscar Freire",
];
const NEIGHBORHOODS = [
  "Centro", "Vila Mariana", "Pinheiros", "Bela Vista", "Jardins", "Santa Cecília",
  "Perdizes", "Itaim Bibi", "Água Branca", "Liberdade", "Higienópolis", "Mooca",
  "Butantã", "Aclimação", "Bom Retiro", "Vila Olímpia",
];

const ORDER_NOTES = ["Sem cebola", "Cliente alérgico a camarão", "Aniversário — levar vela", "Conta dividida em 2", "Sem gelo"];
const CANCEL_REASONS = ["Cliente desistiu", "Pedido duplicado", "Cliente saiu do salão"];
const TAB_LABELS = ["Balcão 01", "Balcão 02", "Balcão 03", "Retirada · Balcão", "Balcão 04", "Retirada · Jantar"];

// Audiência do alerta de abertura — a mesma ORDER_ALERT_AUDIENCE do
// application/alert/alert.usecases.ts (manager/cashier/kitchen; garçom de fora
// de propósito). Replicada aqui porque infra não importa application.
const ORDER_ALERT_AUDIENCE = ["manager", "cashier", "kitchen"];

// ------------------------------------------------------------
// Plano em memória (construído de forma síncrona e determinística ANTES de
// qualquer INSERT — as inserções nunca consomem o RNG).
// ------------------------------------------------------------
type PayMethod = "cash" | "card" | "pix" | "other";
type ItemStatus = "ordered" | "ready" | "delivered" | "cancelled";

type CatalogProduct = {
  id: string;
  name: string;
  price: number;
  costPrice: number;
  trackStock: boolean;
  lowStockThreshold: number;
  variations: string;
  weight: number;
};

type PlanItem = {
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

type PlanPayment = {
  method: PayMethod;
  amount: number;
  received: number | null;
  change: number | null;
};

type PlanDelivery = {
  address: string;
  distanceKm: number;
  estimatedMinutes: number;
  status: "awaiting_courier" | "out_for_delivery" | "delivered" | "failed";
  courierId: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  notes: string | null;
};

type PlanOrder = {
  key: string; // sufixo dos ids (hist-07-03 / open-04)
  id: string; // demo-<key>
  status: "open" | "closed" | "cancelled";
  tableId: string | null;
  tableNumber: string | null; // só p/ texto do alerta ("Mesa 3")
  tabLabel: string | null;
  customerId: string | null;
  customerName: string | null; // só p/ texto do alerta
  channel: "balcao" | "web" | "whatsapp";
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

type PlanDrawerMovement = {
  id: string;
  type: "sangria" | "suprimento";
  amount: number;
  note: string;
  createdAt: string;
};

type PlanDrawer = {
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

type PlanDay = {
  daysAgo: number; // 0 = hoje (só comandas abertas)
  orders: PlanOrder[];
  drawer: PlanDrawer | null; // null = gaveta de hoje pulada (já existe uma aberta)
  isToday: boolean;
};

type People = {
  ana: string;
  carlos: string;
  roberto: string;
  caixa: string;
  entregador: string;
  system: string;
};

type AddrRow = {
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

type TableRow = typeof restaurantTables.$inferSelect;

type Ctx = {
  people: People;
  catalog: CatalogProduct[]; // só produtos com peso > 0 (participam do sorteio)
  catalogByName: Map<string, CatalogProduct>;
  productById: Map<string, { name: string; trackStock: boolean }>;
  trackedProducts: { id: string; name: string; costPrice: number; lowStockThreshold: number }[];
  tables: TableRow[]; // livres, ordenadas por número
  addresses: AddrRow[];
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

/** Total da comanda = MESMA fórmula de computeOrderTotal do app. */
function orderItemsTotal(order: { items: PlanItem[]; deliveryFee: number | null }): number {
  const items = order.items
    .filter((i) => i.status !== "cancelled")
    .reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  return round2(items + (order.deliveryFee ?? 0));
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
    channel = rng.chance(0.55) ? "web" : "whatsapp";
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
// Comandas ABERTAS de hoje — 12 casos cobrindo todos os estados da cozinha,
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
  channel?: "web" | "whatsapp";
  addressIndex?: number;
  minutesAgo: number;
  waiter: "ana" | "carlos" | "system";
  items: OpenItemSpec[];
  payment?: { method: PayMethod; confirmedMinutesAgo?: number }; // sem linha = sem pagamento
  cancelReason?: string;
  deliveryStatus?: PlanDelivery["status"];
  deliveryCourier?: boolean;
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
  // 09 — delivery WhatsApp a caminho, cartão pendente de confirmação
  { suffix: "09", kind: "delivery", channel: "whatsapp", addressIndex: 1, minutesAgo: 80, waiter: "system",
    items: [ { product: "Feijoada Completa", qty: 1, status: "delivered" }, { product: "Suco Natural 500ml", qty: 1, status: "delivered" } ],
    payment: { method: "card" }, deliveryStatus: "out_for_delivery", deliveryCourier: true },
  // 10 — delivery entregue, Pix ainda não caiu
  { suffix: "10", kind: "delivery", channel: "web", addressIndex: 2, minutesAgo: 150, waiter: "system",
    items: [ { product: "Combo Casal", qty: 1, status: "delivered" }, { product: "Mojito", qty: 2, status: "delivered" } ],
    payment: { method: "pix" }, deliveryStatus: "delivered", deliveryCourier: true },
  // 11 — cancelada hoje (salão)
  { suffix: "11", kind: "table", tableIndex: 5, minutesAgo: 30, waiter: "ana", cancelReason: "Cliente desistiu",
    items: [ { product: "Calabresa Acebolada", qty: 1, status: "cancelled", notes: "Cancelado pelo garçom" } ] },
  // 12 — paga e servida, caixa ainda não fechou a conta
  { suffix: "12", kind: "table", tableIndex: 6, minutesAgo: 200, waiter: "carlos",
    items: [ { product: "Frango à Passarinho", qty: 1, status: "delivered" }, { product: "Cerveja Artesanal IPA 500ml", qty: 2, status: "delivered" }, { product: "Brownie com Sorvete", qty: 1, status: "delivered" } ],
    payment: { method: "card", confirmedMinutesAgo: 10 } },
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
        courierId: spec.deliveryCourier ? ctx.people.entregador : null,
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
function buildPlan(ctx: Ctx): PlanDay[] {
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

    const addr = await tx
      .insert(customerAddresses)
      .values(
        Array.from({ length: 16 }, (_, i) => ({
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
        })),
      )
      .onConflictDoNothing({ target: customerAddresses.id })
      .returning();
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
  return {
    ana,
    carlos: byName.get("Carlos Lima") ?? ana,
    roberto,
    caixa: byName.get("Caixa Teste") ?? byRole("cashier") ?? roberto,
    entregador: byName.get("Entregador Teste") ?? byRole("courier") ?? roberto,
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
  const CHANNEL_LABEL: Record<string, string> = { balcao: "Balcão", web: "página", whatsapp: "WhatsApp" };
  const channel = CHANNEL_LABEL[order.channel] ?? order.channel;
  if (order.channel === "web" || order.channel === "whatsapp") {
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
// Runner
// ------------------------------------------------------------
async function main(): Promise<void> {
  console.log("[seed:demo] 1/6 seed base (migrations + usuários + catálogo inicial)…");
  await runBaseSeed();

  console.log("[seed:demo] 2/6 pessoas, catálogo demo e clientes…");
  const people = await resolvePeople();
  await ensureCatalog();
  await ensureCustomers();
  const ctx = await loadCtx(people);

  console.log("[seed:demo] 3/6 construindo plano (30 dias de histórico + comandas abertas)…");
  const plan = buildPlan(ctx);
  const plannedOrders = plan.reduce((sum, d) => sum + d.orders.length, 0);
  const plannedClosed = plan.reduce((sum, d) => sum + d.orders.filter((o) => o.status === "closed").length, 0);
  console.log(
    `[seed:demo] plano: ${plannedOrders} comandas (${plannedClosed} fechadas, ${plan.reduce((s, d) => s + d.orders.filter((o) => o.status === "cancelled").length, 0)} canceladas, ${plan.find((d) => d.isToday)?.orders.length ?? 0} de hoje) · ${plan.length - 1} gavetas históricas · métodos: ${ctx.enabled.join(", ")}`,
  );

  console.log("[seed:demo] 4/6 ajustes iniciais do ledger…");
  await db.transaction(async (tx) => {
    await ensureInitialAdjustments(tx, plan, ctx);
  });

  console.log("[seed:demo] 5/6 dias de histórico (uma transação por dia, do mais antigo ao recente)…");
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

  console.log("[seed:demo] 6/6 marcador de conclusão + validação…");
  await db.transaction(async (tx) => {
    await tx
      .insert(auditLog)
      .values({
        id: "demo-a-seed",
        userId: people.roberto,
        action: "seed_demo",
        orderId: null,
        details: JSON.stringify({ note: "seed:demo concluído — marque este banco como demo; ver cabeçalho de seed-demo.ts" }),
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing({ target: auditLog.id });
  });

  await printSummaryAndValidate();
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDatabase();
    process.exit(1);
  });
