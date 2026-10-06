import {
  BarChart3, Boxes, ChefHat, History, Home, Package, Receipt, Settings, ShoppingCart, Store, Truck, TruckIcon, Users, UtensilsCrossed, Wallet, LayoutDashboard, ClipboardList,
} from "lucide-react";

/**
 * Menu principal por papel: o único lugar do frontend que descreve "o que tem
 * na navegação". Fica em `app/` (e não em `shared/`) porque carrega
 * vocabulário de domínio — `shared` não pode saber o que é comanda, estoque
 * ou gerente (regra testada em `__tests__/fsd-boundaries.test.js`).
 *
 * O `id` dos itens é o mesmo id das abas do gerente, para a troca de tela não
 * virar tradução.
 *
 * TERCEIRO NÍVEL (`children`): um item pode ter submenu. Só "Relatórios" usa
 * hoje — são 4 relatórios que não cabem um a um na coluna de 18rem, e o gerente
 * só costuma olhar um deles por vez. O pai é um grupo (não navega), os filhos
 * são telas. Como o app não tem rota por tela (quem navega é o `NavProvider`,
 * que guarda o id ativo), o id do filho é `reports.overview` — composto, para
 * que o id sozinho já diga de qual grupo veio.
 */
const MANAGER = ({ inventoryEnabled, purchaseEnabled, ifoodIntegrationEnabled }) => [
  {
    id: "inicio",
    label: "Início",
    icon: Home,
    items: [{ id: "home", label: "Início", icon: Home }],
  },
  {
    id: "operacao",
    label: "Operação",
    icon: UtensilsCrossed,
    items: [
      { id: "orders", label: "Comandas", icon: Receipt },
      { id: "cash", label: "Caixa", icon: Wallet },
      { id: "customers", label: "Clientes", icon: Users },
      { id: "deliveries", label: "Entregas", icon: Truck },
      ...(ifoodIntegrationEnabled ? [{ id: "ifood", label: "iFood", icon: Store }] : []),
    ],
  },
  {
    id: "catalogo",
    label: "Catálogo",
    icon: Package,
    items: [
      { id: "catalog", label: "Cadastros", icon: Package },
      ...(inventoryEnabled ? [{ id: "stock", label: "Estoque", icon: Boxes }] : []),
      ...(purchaseEnabled ? [{ id: "compras", label: "Compras", icon: ShoppingCart }] : []),
    ],
  },
  {
    id: "gestao",
    label: "Gestão",
    icon: BarChart3,
    items: [
      { id: "users", label: "Equipe", icon: Users },
      {
        id: "reports",
        label: "Relatórios",
        icon: BarChart3,
        children: [
          { id: "reports.overview", label: "Visão geral", icon: LayoutDashboard },
          { id: "reports.orders", label: "Pedidos", icon: ClipboardList },
          { id: "reports.deliveries", label: "Entregas", icon: TruckIcon },
          { id: "reports.cashflow", label: "Fluxo de caixa", icon: Wallet },
        ],
      },
      { id: "audit", label: "Auditoria", icon: History },
    ],
  },
  {
    id: "sistema",
    label: "Sistema",
    icon: Settings,
    items: [{ id: "settings", label: "Configurações", icon: Settings }],
  },
];
    
// Perfis de tela única: uma seção com um item. O menu degenera para um botão
// (trilho de 64px no desktop) — os filtros de garçom e cozinha continuam na
// lista, onde estão ao alcance do polegar.
const SINGLE_SCREEN = {
  waiter: { section: "Comandas", item: "orders", icon: Receipt },
  kitchen: { section: "Produção", item: "kitchen", icon: ChefHat },
  courier: { section: "Entregas", item: "deliveries", icon: Truck },
};

function singleScreen(role) {
  const { section, item, icon } = SINGLE_SCREEN[role];
  return [{ id: section, label: section, icon, items: [{ id: item, label: section, icon }] }];
}

// Caixa tem duas telas: o fluxo de caixa e a manutenção de clientes (o balcão
// identifica o cliente antes de abrir a comanda). Seção própria, como o
// gerente — o menu vira coluna por causa do segundo item.
const CASHIER = [
  {
    id: "operacao",
    label: "Operação",
    icon: Wallet,
    items: [
      { id: "cash", label: "Caixa", icon: Wallet },
      { id: "customers", label: "Clientes", icon: Users },
    ],
  },
];

/** Seções do menu do papel, já filtradas pelos feature-toggles. */
export function menuSectionsFor(role, { inventoryEnabled = false, purchaseEnabled = false, ifoodIntegrationEnabled = false } = {}) {
  if (role === "manager") return MANAGER({ inventoryEnabled, purchaseEnabled, ifoodIntegrationEnabled });
  if (role === "cashier") return CASHIER;
  return singleScreen(role in SINGLE_SCREEN ? role : "waiter");
}

/** Existe algo para expandir? Sem isso o menu vira um trilho de ícones. */
export function hasExpandableSections(sections) {
  return sections.some((s) => s.items.length > 1);
}

/**
 * Todas as telas do menu, incluindo as de submenu (`children`), na ordem em que
 * aparecem. O `AppMenu` usa para validar o id guardado e `ManagerApp` para o
 * mapa de telas — se os dois fizessem a busca por conta própria, o terceiro
 * nível apareceria num e sumiria no outro.
 */
export function allItems(sections) {
  return sections.flatMap((s) => [
    ...s.items,
    ...s.items.filter((i) => i.children?.length).flatMap((i) => i.children),
  ]);
}

/** A seção (e o item pai, se o id for de um filho) dona de um id de tela. */
export function sectionOwning(sections, id) {
  for (const s of sections) {
    if (s.items.some((i) => i.id === id)) return s;
    const parent = s.items.find((i) => i.children?.some((c) => c.id === id));
    if (parent) return s;
  }
  return null;
}

export function firstItemId(sections) {
  const first = sections[0]?.items[0];
  if (!first) return null;
  return first.children?.[0]?.id ?? first.id;
}
