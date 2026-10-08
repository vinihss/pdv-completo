import React from "react";
import { useToast, Toast } from "@/shared/components";
import { OrderBoard } from "@/widgets/order-board";
import { CashDrawerTab } from "@/widgets/cash-drawer";
import DeliveriesTab from "./tabs/deliveries/DeliveriesTab.jsx";
import CatalogTab from "./tabs/catalog/CatalogTab.jsx";
import UsersTab from "./tabs/users/UsersTab.jsx";
import OverviewTab from "./tabs/reports/OverviewTab.jsx";
import OrdersReportTab from "./tabs/reports/OrdersReportTab.jsx";
import DeliveriesReportTab from "./tabs/reports/DeliveriesReportTab.jsx";
import CashFlowReportTab from "./tabs/reports/CashFlowReportTab.jsx";
import AuditTab from "./tabs/audit/AuditTab.jsx";
import IfoodTab from "./tabs/ifood/IfoodTab.jsx";
import SettingsTab from "./tabs/settings/SettingsTab.jsx";
import StockTab from "./tabs/inventory/StockTab.jsx";
import PurchaseTab from "./tabs/purchase/PurchaseTab.jsx";
import CustomersTab from "./tabs/customers/CustomersTab.jsx";
import ManagerHome from "./tabs/home/ManagerHome.jsx";
import ProfilePage from "./tabs/profile/ProfilePage";
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
    // Sem tela "whatsapp": o painel do WhatsApp mora em Configurações
    // (SettingsTab), atrás do toggle "Integração WhatsApp". Um activeId
    // guardado de uma versão antiga cai em Comandas pelo fallback do AppMenu.
    settings: <SettingsTab showToast={showToast} />,
  };

  // `activeId` inválido (item guardado de uma versão antiga, toggle desligado)
  // cai na Home — nunca numa tela vazia.
  return (
    <div className="min-h-screen bg-stone-950 text-stone-50">
      {SCREENS[activeId] ?? SCREENS.home}
      <Toast toast={toast} />
    </div>
  );
}
