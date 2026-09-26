import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LogOut } from "lucide-react";
import { AuthProvider, useAuth } from "@/app/providers/auth";
import { PdvPage } from "@/pages/pdv";
import { ManagerApp } from "@/pages/manager";
import { KitchenDisplay } from "@/pages/kitchen";
import { CourierApp } from "@/pages/courier";
import { CashierApp } from "@/pages/cashier";
import { CustomerMenuPage } from "@/pages/customer-menu";
import { LoginPage } from "@/pages/login";

export function AppFrame({ children }) {
  const { logout, storeSettings } = useAuth();
  return (
    <div className="relative">
      <div className="sticky top-0 z-40 h-14 flex items-center justify-between px-4 bg-stone-900/95 backdrop-blur border-b border-stone-800">
        <div className="flex items-center gap-2.5 min-w-0">
          {storeSettings?.logoUrl ? (
            <div className="h-9 w-9 rounded-full bg-stone-800 border border-stone-700 flex items-center justify-center overflow-hidden shrink-0">
              <img src={storeSettings.logoUrl} alt="Logo do restaurante" className="w-full h-full object-contain" />
            </div>
          ) : (
            <div className="h-9 w-9 rounded-full bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-500 shrink-0">
              <span className="text-xs font-bold">{storeSettings?.merchantName?.[0] ?? "B"}</span>
            </div>
          )}
          <span className="text-sm font-semibold text-stone-400 truncate">{storeSettings?.merchantName ?? "Bar do Zé"}</span>
        </div>
        <button
          onClick={logout}
          title="Trocar usuário"
          aria-label="Trocar usuário"
          className="flex items-center gap-1.5 text-stone-300 hover:text-red-400 text-xs font-semibold transition-colors"
        >
          <LogOut size={16} />
          Sair
        </button>
      </div>
      {children}
    </div>
  );
}

// Mapa de telas por papel do usuário logado (extensível para novos papéis)
const SCREENS_BY_ROLE = {
  waiter: <PdvPage />,
  manager: <ManagerApp />,
  kitchen: <KitchenDisplay />,
  courier: <CourierApp />,
  cashier: <CashierApp />,
};

export function Root() {
  const { session, booting } = useAuth();

  if (booting) {
    return <div className="min-h-screen bg-stone-950" />;
  }

  if (!session) {
    return <LoginPage />;
  }

  return <AppFrame>{SCREENS_BY_ROLE[session.user.role] ?? <PdvPage />}</AppFrame>;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Pública, sem login — cliente final, chega direto ou pelo link do bot (§04/05) */}
        <Route path="/pedido/*" element={<CustomerMenuPage />} />
        {/* Tudo mais: exige login, roteado por papel */}
        <Route
          path="/*"
          element={
            <AuthProvider>
              <Root />
            </AuthProvider>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
