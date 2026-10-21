// DADOS PUROS do seed de demonstração — o catálogo demo, os clientes e os
// helpers de data. Tudo aqui é CONSTANTE ou função sem efeito colateral: nada
// toca o banco e nada consome o RNG do plano.
//
// POR QUE UM MÓDULO SÓ PARA ISSO: o seed demo é grande (30 dias de histórico
// gerados) e a parte que decide O QUE existe (dados) é pequena e estável,
// enquanto a parte que decide COMO o plano é montado (`plan.ts`) muda toda
// vez que a demonstração cresce. Separar deixa o diff do "conteúdo" pequeno
// e o do "algoritmo" isolado.
//
// Este módulo é importado tanto pelo plano (`plan.ts`) quanto pela fase de
// dados (`seeds/demo.ts`).

export const pad2 = (n: number) => String(n).padStart(2, "0");

// ------------------------------------------------------------
// Datas: os timestamps do schema são text ISO-8601 UTC, e os relatórios
// agrupam por dia LOCAL da loja (offset do cliente). Para o mesmo evento cair
// no MESMO dia calendário com tz=0 (default do backend) e com -03:00 (BR),
// todo o histórico é gerado entre 14:00Z e 22:59Z — 11h às 19h30 em Brasília.
// Nada é gerado para "hoje" de propósito: dependendo do horário da execução,
// hoje ainda tem o dia inteiro pela frente e uma venda futura é ruim.
// ------------------------------------------------------------
export function dayStartUtc(daysAgo: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

export function isoOnDay(daysAgo: number, hour: number, minute: number): string {
  const d = dayStartUtc(daysAgo);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

export function isoMinus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

export function isoPlus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

// ------------------------------------------------------------
// Catálogo demo (além dos 6 produtos do seed base). Categorias e grupos de
// cozinha novos entram junto; ids determinísticos `demo-*`.
// ------------------------------------------------------------
export type VariationDef = { name: string; options: string[]; required?: boolean };

export type ProductDef = {
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

export const DEMO_CATEGORIES = [
  { id: "demo-cat-cocktails", name: "Cocktails", displayOrder: 4 },
  { id: "demo-cat-sobremesas", name: "Sobremesas", displayOrder: 5 },
  { id: "demo-cat-entradas", name: "Entradas", displayOrder: 6 },
];

export const DEMO_KITCHEN_GROUPS = [
  { id: "demo-kg-forno", name: "Forno", displayOrder: 4 },
  { id: "demo-kg-doces", name: "Doces", displayOrder: 5 },
];

export const DEMO_PRODUCTS: ProductDef[] = [
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
export const BASE_WEIGHTS: Record<string, number> = {
  "Chopp 300ml": 5,
  "Caipirinha": 3,
  "X-Burger": 4,
  "Filé à parmegiana": 2,
  "Batata frita": 3,
  "Isca de peixe": 1,
};

// Produtos rastreados que terminam ABAIXO do threshold para a tela de Estoque
// já nascer com item em alerta (a base já deixa "Batata frita" baixa).
export const LOW_STOCK_TARGETS: Record<string, number> = {
  "Batata frita": 9, // threshold 15
  "Cerveja Long Neck": 22, // threshold 36
  "Pudim de Leite": 6, // threshold 10
};

// ------------------------------------------------------------
// Clientes: 40 nomes + 16 com endereço (bom para delivery).
// Nada aqui consome o RNG do plano — números/fones são fórmulas puras, para
// que a ordem de construção do plano seja idêntica em qualquer execução.
// ------------------------------------------------------------
export const CUSTOMER_NAMES = [
  "Mariana Souza", "Rafael Oliveira", "Juliana Pereira", "Bruno Santos", "Camila Rodrigues",
  "Diego Almeida", "Fernanda Lima", "Gustavo Costa", "Helena Martins", "Igor Ferreira",
  "Larissa Alves", "Marcelo Ribeiro", "Natália Barbosa", "Otávio Cardoso", "Patrícia Gomes",
  "Renato Dias", "Sabrina Machado", "Thiago Araújo", "Vanessa Correia", "Wesley Moreira",
  "Amanda Teixeira", "Caio Figueiredo", "Débora Nunes", "Eduardo Pinto", "Flávia Carvalho",
  "Giovanni Roveri", "Isabela Monteiro", "João Pedro Braga", "Karina Freitas", "Lucas Tavares",
  "Mirela Antunes", "Nelson Batista", "Olívia Ramalho", "Paulo Sérgio Melo", "Queila Duarte",
  "Ricardo Assunção", "Simone Xavier", "Tiago Albuquerque", "Ubiratã Lopes", "Vitória Sampaio",
];

export const STREETS = [
  "Rua das Palmeiras", "Av. Brasil", "Rua Augusta", "Rua Joaquim Nabuco", "Av. Paulista",
  "Rua dos Pinheiros", "Rua Sete de Setembro", "Rua do Comércio", "Av. Independência",
  "Rua Bela Cintra", "Rua Haddock Lobo", "Rua Consolação", "Rua Minas Gerais",
  "Rua Tabapuã", "Av. Rebouças", "Rua Oscar Freire",
];
export const NEIGHBORHOODS = [
  "Centro", "Vila Mariana", "Pinheiros", "Bela Vista", "Jardins", "Santa Cecília",
  "Perdizes", "Itaim Bibi", "Água Branca", "Liberdade", "Higienópolis", "Mooca",
  "Butantã", "Aclimação", "Bom Retiro", "Vila Olímpia",
];

// Base das coordenadas demo: Praça da Sé, São Paulo. Os endereços são
// espalhados em grade em volta (ver ensureCustomers) para o mapa do gerente
// nascer com markers de pedido, e os motoboys em rota com posição conhecida —
// sem coordenada, `GET /manager/deliveries` devolve `addressLatitude` nulo e o
// mapa fica vazio.
export const DEMO_BASE_LAT = -23.5505;
export const DEMO_BASE_LNG = -46.6333;

export const ORDER_NOTES = ["Sem cebola", "Cliente alérgico a camarão", "Aniversário — levar vela", "Conta dividida em 2", "Sem gelo"];
export const CANCEL_REASONS = ["Cliente desistiu", "Pedido duplicado", "Cliente saiu do salão"];
export const TAB_LABELS = ["Balcão 01", "Balcão 02", "Balcão 03", "Retirada · Balcão", "Balcão 04", "Retirada · Jantar"];

// Audiência do alerta de abertura — a mesma ORDER_ALERT_AUDIENCE do
// application/alert/alert.usecases.ts (manager/cashier/kitchen; garçom de fora
// de propósito). Replicada aqui porque infra não importa application.
export const ORDER_ALERT_AUDIENCE = ["manager", "cashier", "kitchen"];
