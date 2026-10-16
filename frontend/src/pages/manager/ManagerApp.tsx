import { useAuth } from "@/app/providers/auth";
import { useNav } from "@/app/providers/nav";
import { Toast, useToast } from "@/shared/components";
import { CashDrawerTab } from "@/widgets/cash-drawer";
import { OrderBoard } from "@/widgets/order-board";
import React from "react";
import AuditTab from "./tabs/audit/AuditTab.jsx";
import CatalogTab from "./tabs/catalog/CatalogTab.jsx";
import CustomersTab from "./tabs/customers/CustomersTab.jsx";
import DeliveriesTab from "./tabs/deliveries/DeliveriesTab.jsx";
import ManagerHome from "./tabs/home/ManagerHome.jsx";
import IfoodTab from "./tabs/ifood/IfoodTab.jsx";
import StockTab from "./tabs/inventory/StockTab.jsx";
import ProfilePage from "./tabs/profile/ProfilePage";
import PurchaseTab from "./tabs/purchase/PurchaseTab.jsx";
import CashFlowReportTab from "./tabs/reports/CashFlowReportTab.jsx";
import DeliveriesReportTab from "./tabs/reports/DeliveriesReportTab.jsx";
import OrdersReportTab from "./tabs/reports/OrdersReportTab.jsx";
import OverviewTab from "./tabs/reports/OverviewTab.jsx";
import SettingsTab from "./tabs/settings/SettingsTab.jsx";
import SettlementTab from "./tabs/settlement/SettlementTab.jsx";
import UsersTab from "./tabs/users/UsersTab.jsx";

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
  // componentes e evita onze condicionais.
  const SCREENS = {
    home: <ManagerHome showToast={showToast} />,
    orders: <OrderBoard />,
    cash: <CashDrawerTab showToast={showToast} />,
    customers: <CustomersTab showToast={showToast} />,
    deliveries: <DeliveriesTab showToast={showToast} />,
    catalog: <CatalogTab showToast={showToast} />,
    stock: <StockTab showToast={showToast} purchaseEnabled={purchaseEnabled} />,
    compras: <PurchaseTab showToast={showToast} />,
    users: <UsersTab showToast={showToast} />,
    // Os quatro relatórios são telas independentes (ids `reports.*` do
    // submenu), não abas de uma tela só. `reports` sem sufixo é o id do GRUPO
    // no menu — não navega para lugar nenhum, e fica aqui só para que uma
    // sessão salva com o id antigo (antes do submenu) não caia em branco.
    reports: <OverviewTab showToast={showToast} />,
    "reports.overview": <OverviewTab showToast={showToast} />,
    "reports.orders": <OrdersReportTab showToast={showToast} />,
    "reports.deliveries": <DeliveriesReportTab showToast={showToast} />,
    "reports.cashflow": <CashFlowReportTab showToast={showToast} />,
    ifood: <IfoodTab showToast={showToast} />,
    audit: <AuditTab />,
    profile: <ProfilePage showToast={showToast} />,
    settings: <SettingsTab showToast={showToast} />,
  };

  // `activeId` inválido (item guardado de uma versão antiga, toggle desligado)
  // cai na Home — nunca numa tela vazia.
  return (
    <div className="min-h-screen bg-background text-foreground">
      {SCREENS[activeId] ?? SCREENS.home}
      <Toast toast={toast} />
    </div>
  );
}
