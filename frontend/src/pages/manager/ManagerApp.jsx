import React from "react";
import { useToast, Toast } from "@/shared/components";
import { OrderBoard } from "@/widgets/order-board";
import { CashDrawerTab } from "@/widgets/cash-drawer";
import DeliveriesTab from "./tabs/deliveries/DeliveriesTab.jsx";
import CatalogTab from "./tabs/catalog/CatalogTab.jsx";
import UsersTab from "./tabs/users/UsersTab.jsx";
import ReportsTab from "./tabs/reports/ReportsTab.jsx";
import AuditTab from "./tabs/audit/AuditTab.jsx";
import IfoodTab from "./tabs/ifood/IfoodTab.jsx";
import SettingsTab from "./tabs/settings/SettingsTab.jsx";
import StockTab from "./tabs/inventory/StockTab.jsx";
import PurchaseTab from "./tabs/purchase/PurchaseTab.jsx";
import { useAuth } from "@/app/providers/auth";
import { useNav } from "@/app/providers/nav";

// A tela ativa vem do menu principal (widgets/app-menu, desenhado pela casca),
// não de um estado local: as duas coisas são irmãs na árvore, então quem
// guarda o estado é o `NavProvider`. O `id` de cada tela é o mesmo do item
// correspondente no menu — ver `app/providers/nav/menuSections.js`.
export default function ManagerApp() {
  const { storeSettings } = useAuth();
  const { activeId } = useNav();
  const { toast, showToast } = useToast();

  const purchaseEnabled = storeSettings?.purchaseEnabled ?? false;

  // Só a tela escolhida é montada; o mapa inteiro é barato (elementos, não
  // componentes) e evita onze condicionais.
  const SCREENS = {
    orders: <OrderBoard />,
    cash: <CashDrawerTab showToast={showToast} />,
    deliveries: <DeliveriesTab showToast={showToast} />,
    catalog: <CatalogTab showToast={showToast} />,
    stock: <StockTab showToast={showToast} purchaseEnabled={purchaseEnabled} />,
    compras: <PurchaseTab showToast={showToast} />,
    users: <UsersTab showToast={showToast} />,
    reports: <ReportsTab showToast={showToast} />,
    ifood: <IfoodTab showToast={showToast} />,
    audit: <AuditTab />,
    settings: <SettingsTab showToast={showToast} />,
  };

  // `activeId` inválido (item guardado de uma versão antiga, toggle desligado)
  // cai em Comandas — nunca numa tela vazia.
  return (
    <div className="min-h-screen bg-stone-950 text-stone-50">
      {SCREENS[activeId] ?? SCREENS.orders}
      <Toast toast={toast} />
    </div>
  );
}
