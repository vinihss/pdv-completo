import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LogOut, Menu } from "lucide-react";
import { AuthProvider, useAuth } from "@/app/providers/auth";
import { NavProvider, useNav } from "@/app/providers/nav";
import { PdvPage } from "@/pages/pdv";
import { ManagerApp } from "@/pages/manager";
import { KitchenDisplay } from "@/pages/kitchen";
import { CourierApp } from "@/pages/courier";
import { CashierApp } from "@/pages/cashier";
import { CustomerMenuPage } from "@/pages/customer-menu";
import { LoginPage } from "@/pages/login";
import { AppMenu } from "@/widgets/app-menu";

export function AppFrame({ children }) {
  const { logout, storeSettings } = useAuth();
  const { drawerOpen, openDrawer } = useNav();
  return (
    <div className="relative min-h-screen">
      <div className="sticky top-0 z-40 h-14 flex items-center gap-2 px-3 sm:px-4 bg-stone-900/95 backdrop-blur border-b border-stone-800">
        {/* Só no celular: a partir de lg o menu é a coluna da esquerda. */}
        <button
          type="button"
          onClick={openDrawer}
          aria-label="Abrir menu"
          aria-expanded={drawerOpen}
          aria-controls="app-menu-painel"
          className="lg:hidden w-10 h-10 -ml-1 flex items-center justify-center rounded-full text-stone-300 hover:text-stone-100 transition-colors shrink-0"
        >
          <Menu size={20} />
        </button>
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
          <span className="text-sm font-semibold text-stone-400 truncate">{storeSettings?.merchantName ?? "PDV"}</span>
        </div>
        <button
          onClick={logout}
          title="Trocar usuário"
          aria-label="Trocar usuário"
          className="flex items-center gap-1.5 text-stone-300 hover:text-red-400 text-xs font-semibold transition-colors shrink-0"
        >
          <LogOut size={16} />
          Sair
        </button>
      </div>
      <div className="flex items-start">
        <AppMenu />
        <main className="flex-1 min-w-0">{children}</main>
      </div>
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

  return (
    <NavProvider role={session.user.role}>
      <AppFrame>{SCREENS_BY_ROLE[session.user.role] ?? <PdvPage />}</AppFrame>
    </NavProvider>
  );
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
