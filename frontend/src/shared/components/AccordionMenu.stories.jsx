import { useState } from "react";
import { BarChart3, Package, Receipt, Settings, Users, Wallet } from "lucide-react";
import AccordionMenu from "./AccordionMenu.jsx";

const sections = [
  {
    id: "operacao",
    label: "Operação",
    icon: Receipt,
    items: [
      { id: "orders", label: "Comandas", icon: Receipt, badge: 2 },
      { id: "cash", label: "Caixa", icon: Wallet },
    ],
  },
  {
    id: "gestao",
    label: "Gestão",
    icon: Users,
    items: [
      { id: "team", label: "Equipe", icon: Users },
      {
        id: "reports",
        label: "Relatórios",
        icon: BarChart3,
        children: [
          { id: "reports.sales", label: "Vendas", icon: BarChart3 },
          { id: "reports.stock", label: "Estoque", icon: Package, badge: 3 },
        ],
      },
    ],
  },
  {
    id: "system",
    label: "Sistema",
    icon: Settings,
    items: [{ id: "settings", label: "Configurações", icon: Settings }],
  },
];

const meta = {
  title: "Design System/Patterns/AccordionMenu",
  component: AccordionMenu,
  tags: ["autodocs"],
  args: { variant: "full" },
  argTypes: { variant: { control: "inline-radio", options: ["full", "rail"] } },
};

export default meta;

function MenuExample({ variant = "full" }) {
  const [activeId, setActiveId] = useState("orders");
  return (
    <div className={`min-h-96 rounded-2xl bg-sidebar text-sidebar-foreground ${variant === "rail" ? "w-20" : "w-64"}`}>
      <div className="border-b border-sidebar-border px-4 py-4 font-display font-bold">{variant === "rail" ? "CP" : "Cheempa PDV"}</div>
      <AccordionMenu
        sections={sections}
        activeId={activeId}
        onSelect={setActiveId}
        variant={variant}
        footer={variant === "full" ? <div className="border-t border-sidebar-border px-3 py-3 text-xs text-sidebar-foreground/70">Ana Ribeiro · Gerente</div> : undefined}
      />
    </div>
  );
}

export const MenuCompleto = { render: (args) => <MenuExample {...args} variant="full" /> };
export const TrilhoCompacto = { render: () => <MenuExample variant="rail" /> };
