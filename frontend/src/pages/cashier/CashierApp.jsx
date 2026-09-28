import React from "react";
import { useToast, Toast } from "@/shared/components";
import { CashDrawerTab } from "@/widgets/cash-drawer";
import CustomersTab from "../manager/tabs/customers/CustomersTab.jsx";
import { useNav } from "@/app/providers/nav";

// App do perfil "caixa": fluxo de caixa + manutenção de clientes (o balcão
// identifica o cliente antes de abrir a comanda). A tela ativa vem do menu
// principal, como no gerente — ver `app/providers/nav/menuSections.js`.
export default function CashierApp() {
  const { toast, showToast } = useToast();
  const { activeId } = useNav();

  const SCREENS = {
    cash: <CashDrawerTab showToast={showToast} />,
    customers: <CustomersTab showToast={showToast} />,
  };

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50">
      {SCREENS[activeId] ?? SCREENS.cash}
      <Toast toast={toast} />
    </div>
  );
}
