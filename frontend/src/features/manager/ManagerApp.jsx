import React, { useState } from "react";
import {
  Receipt, Settings, Package, Users, BarChart3, History, Truck, Store, Wallet,
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

const TABS = [
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
  const [tab, setTab] = useState("orders");
  const { toast, showToast } = useToast();

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
      <Toast toast={toast} />
    </div>
  );
}