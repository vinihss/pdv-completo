import {
  BarChart3, Boxes, ChefHat, History, Package, Receipt, Settings, ShoppingCart, Store, Truck, Users, UtensilsCrossed, Wallet,
} from "lucide-react";

/**
 * Menu principal por papel: o único lugar do frontend que descreve "o que tem
 * na navegação". Fica em `app/` (e não em `shared/`) porque carrega
 * vocabulário de domínio — `shared` não pode saber o que é comanda, estoque
 * ou gerente (regra testada em `__tests__/fsd-boundaries.test.js`).
 *
 * O `id` dos itens é o mesmo id das abas do gerente, para a troca de tela não
 * virar tradução.
 */
const MANAGER = ({ inventoryEnabled, purchaseEnabled, ifoodIntegrationEnabled }) => [
  {
    id: "operacao",
    label: "Operação",
    icon: UtensilsCrossed,
    items: [
      { id: "orders", label: "Comandas", icon: Receipt },
      { id: "cash", label: "Caixa", icon: Wallet },
      { id: "customers", label: "Clientes", icon: Users },
      { id: "deliveries", label: "Entregas", icon: Truck },
      // iFood só quando a integração está ligada em Configurações.
      ...(ifoodIntegrationEnabled ? [{ id: "ifood", label: "iFood", icon: Store }] : []),
      // O WhatsApp não é mais item de menu: o painel mora dentro de
      // Configurações (SettingsTab), atrás do toggle "Integração WhatsApp".
    ],
  },
  {
    id: "catalogo",
    label: "Catálogo",
    icon: Package,
    items: [
      { id: "catalog", label: "Cadastros", icon: Package },
      // Abas extras por feature-toggle, como na antiga barra de abas.
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
      { id: "reports", label: "Relatórios", icon: BarChart3 },
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
export function menuSectionsFor(
  role,
  { inventoryEnabled = false, purchaseEnabled = false, ifoodIntegrationEnabled = false } = {}
) {
  if (role === "manager") return MANAGER({ inventoryEnabled, purchaseEnabled, ifoodIntegrationEnabled });
  if (role === "cashier") return CASHIER;
  return singleScreen(role in SINGLE_SCREEN ? role : "waiter");
}

/** Existe algo para expandir? Sem isso o menu vira um trilho de ícones. */
export function hasExpandableSections(sections) {
  return sections.some((s) => s.items.length > 1);
}

export function firstItemId(sections) {
  return sections[0]?.items[0]?.id ?? null;
}
