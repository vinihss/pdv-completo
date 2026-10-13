/**
 * Router principal do app.
 *
 * Rotas:
 *   /login     — LoginPage (todos os perfis)
 *   /pdv       — PdvPage (waiter)
 *   /manager   — ManagerApp (manager)
 *   /kitchen   — KitchenDisplay (kitchen)
 *   /cashier   — CashierApp (cashier)
 *   /courier   — CourierApp (courier)
 *   /pedido    — CustomerMenuPage (público)
 *
 * Providers:
 *   AuthProvider — autenticação e sessão
 *   NavProvider — navegação e menu
 *   AlertsProvider — central de alertas
 *   OrderFocusProvider — foco na comanda
 *
 * Componentes:
 *   AppFrame — casca com header, menu e alertas
 *   AppMenu — menu principal (sempre expandido)
 *   AlertBell — sino de alertas
 */
import React from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { Menu, LogOut } from "lucide-react";
import { AuthProvider, useAuth } from "@/app/providers/auth";
import { NavProvider, useNav, useMenuSections } from "@/app/providers/nav";
import { AlertsProvider } from "@/app/providers/alerts";
import { OrderFocusProvider } from "@/app/providers/order-focus";
import { PdvPage } from "@/pages/pdv";
import { ManagerApp } from "@/pages/manager";
import { KitchenDisplay } from "@/pages/kitchen";
import { CourierApp } from "@/pages/courier";
import { CashierApp } from "@/pages/cashier";
import { CustomerMenuPage } from "@/pages/customer-menu";
import { LoginPage } from "@/pages/login";
import { AppMenu } from "@/widgets/app-menu";
import { AlertBell } from "@/widgets/alert-bell";
import ProfilePage from "@/pages/manager/tabs/profile/ProfilePage";

export function AppFrame({ children }) {
  const { logout, storeSettings } = useAuth();
  const { drawerOpen, openDrawer } = useNav();

  // Mesma conta do AppMenu (fonte única em useMenuSections): 1 item de menu
  // não justifica coluna nem botão de menu — o perfil é de tela única.
  const menuSections = useMenuSections();
  const totalMenuItems = React.useMemo(
    () => menuSections.flatMap((s) => s.items).length,
    [menuSections]
  );

  const singleItem = totalMenuItems === 1;

  return (
    <div className="relative min-h-screen">
      <div className="sticky top-0 z-40 h-14 flex items-center gap-2 px-3 sm:px-4 bg-stone-900/95 backdrop-blur border-b border-stone-800">
        {/* Só no celular: a partir de lg o menu é a coluna da esquerda. */}
        {!singleItem && (
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
        )}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
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
        {/* Sino de alertas + LED de conexão */}
        <AlertBell />
        {/* Perfis de tela única (waiter, kitchen, courier) não têm menu lateral:
            o logout fica no header. Para os demais, está no rodapé do menu. */}
        {singleItem && (
          <button
            type="button"
            onClick={logout}
            aria-label="Sair"
            title="Sair"
            className="w-10 h-10 -mr-1 flex items-center justify-center rounded-full text-stone-300 hover:text-stone-100 hover:bg-stone-800/60 transition-colors shrink-0"
          >
            <LogOut size={20} />
          </button>
        )}
      </div>
      <div className="flex items-start">
        {!singleItem && <AppMenu />}
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
  const location = useLocation();

  if (booting) {
    return <div className="min-h-screen bg-stone-950" />;
  }

  if (!session) {
    return <LoginPage />;
  }

  // Perfil do usuário logado: página standalone dentro do AuthProvider
  // (usa useAuth/useNavigate; não precisa de NavProvider/AlertsProvider).
  if (location.pathname === "/manager/profile") {
    return <ProfilePage />;
  }

  // Ordem: `NavProvider` primeiro (o `OrderFocusProvider` troca a tela ativa ao
  // focar uma comanda), `AlertsProvider` por cima de tudo (o sino é da casca e
  // o `Toast` dele vive aqui, não na página).
  return (
    <NavProvider role={session.user.role}>
      <AlertsProvider>
        <OrderFocusProvider>
          <AppFrame>{SCREENS_BY_ROLE[session.user.role] ?? <PdvPage />}</AppFrame>
        </OrderFocusProvider>
      </AlertsProvider>
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
