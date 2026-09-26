import React, { useState, useEffect, useCallback } from "react";
import {
  Receipt, Settings, Package, Users, BarChart3, History, Truck, Store, Wallet, Boxes, ShoppingCart,
} from "lucide-react";
import { useToast, Toast } from "@/shared/components";
import { OrdersRoot } from "@/features/orders";
import { DeliveriesTab } from "@/features/deliveries";
import { CatalogTab } from "@/features/catalog";
import { UsersTab } from "@/features/users";
import { ReportsTab } from "@/features/reports";
import { AuditTab } from "@/features/audit";
import { IfoodTab } from "@/features/ifood";
import { SettingsTab } from "@/features/settings";
import { CashDrawerTab } from "@/features/cashdrawer";
import { StockTab } from "@/features/inventory";
import { PurchaseTab } from "@/features/purchase";
import { useAuth } from "@/app/providers/auth";
import { listStock } from "@/entities/stock";
import { useRealtime } from "@/shared/hooks";

const BASE_TABS = [
  { id: "orders", label: "Comandas", icon: Receipt },
  { id: "cash", label: "Caixa", icon: Wallet },
  { id: "deliveries", label: "Entregas", icon: Truck },
  { id: "catalog", label: "Cadastros", icon: Package },
  { id: "users", label: "Equipe", icon: Users },
  { id: "reports", label: "Relatórios", icon: BarChart3 },
  { id: "ifood", label: "iFood", icon: Store },
  { id: "audit", label: "Auditoria", icon: History },
  { id: "settings", label: "Configurações", icon: Settings },
];

export default function ManagerApp() {
  const { storeSettings, session } = useAuth();
  const [tab, setTab] = useState("orders");
  const [lowCount, setLowCount] = useState(0);
  const { toast, showToast } = useToast();

  const inventoryEnabled = storeSettings?.inventoryEnabled ?? false;
  const purchaseEnabled = storeSettings?.purchaseEnabled ?? false;

  // Badge de estoque baixo na aba (resumo barato: 1 chamada com low_only).
  const refreshLowCount = useCallback(() => {
    if (!inventoryEnabled) return;
    listStock({ low_only: "true", limit: 1 })
      .then((r) => setLowCount(r.total))
      .catch(() => {});
  }, [inventoryEnabled]);
  useEffect(() => {
    setLowCount(0);
    refreshLowCount();
  }, [refreshLowCount]);

  // Atualiza o contador ao vivo (qualquer movimento de estoque em qualquer tela).
  useRealtime(session?.token, inventoryEnabled ? ["inventory"] : [], (msg) => {
    if (msg.type === "stock.movement" || msg.type === "stock.low") refreshLowCount();
  });

  // Abas extras por feature-toggle: Estoque (inventory_enabled) e Compras
  // (purchase_enabled) entram entre Cadastros e Equipe.
  const TABS = [
    ...BASE_TABS.slice(0, 4),
    ...(inventoryEnabled ? [{ id: "stock", label: "Estoque", icon: Boxes }] : []),
    ...(purchaseEnabled ? [{ id: "compras", label: "Compras", icon: ShoppingCart }] : []),
    ...BASE_TABS.slice(4),
  ];

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50">
      <div className="sticky top-12 z-20 bg-stone-950/95 backdrop-blur border-b border-stone-900 px-3 pt-3">
        <div className="flex gap-1 overflow-x-auto pb-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors ${
                tab === t.id ? "bg-amber-500 text-stone-950" : "bg-stone-900 border border-stone-800 text-stone-400"
              }`}
            >
              <t.icon size={13} /> {t.label}
              {t.id === "stock" && lowCount > 0 && (
                <span className="ml-0.5 bg-red-500 text-white rounded-full min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center text-[10px] font-bold">
                  {lowCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

{tab === "orders" && <OrdersRoot />}
  {tab === "cash" && <CashDrawerTab showToast={showToast} />}
  {tab === "deliveries" && <DeliveriesTab showToast={showToast} />}
  {tab === "catalog" && <CatalogTab showToast={showToast} />}
  {tab === "users" && <UsersTab showToast={showToast} />}
  {tab === "reports" && <ReportsTab showToast={showToast} />}
  {tab === "ifood" && <IfoodTab showToast={showToast} />}
  {tab === "audit" && <AuditTab />}
  {tab === "settings" && <SettingsTab showToast={showToast} />}
  {tab === "compras" && <PurchaseTab showToast={showToast} />}
  {tab === "stock" && <StockTab showToast={showToast} purchaseEnabled={purchaseEnabled} />}
      <Toast toast={toast} />
    </div>
  );
}