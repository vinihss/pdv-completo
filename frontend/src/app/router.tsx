import { AlertsProvider } from "@/app/providers/alerts";
import { AuthProvider, useAuth } from "@/app/providers/auth";
import { NavProvider, useMenuSections, useNav } from "@/app/providers/nav";
import { OrderFocusProvider } from "@/app/providers/order-focus";
import { LogOut, Menu } from "lucide-react";
/**
 * Router principal do app com Code-Splitting (React.lazy).
 *
 * Rotas:
 *   /login         — LoginPage (identidade centralizada: e-mail + senha)
 *   /login/pin     — LoginPagePin (rota fallback da tela antiga, docs/26 §2 decisão 5)
 *   /reset-password— ResetPasswordPage (pública, chega por link de e-mail)
 *   /pdv           — PdvPage (waiter)
 *   /manager       — ManagerApp (manager)
 *   /kitchen       — KitchenDisplay (kitchen)
 *   /cashier       — CashierApp (cashier)
 *   /courier       — CourierApp (courier)
 *   /pedido        — CustomerMenuPage (público)
 */
import React, { Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { ThemeToggle } from "@/shared/components";
import { AlertBell } from "@/widgets/alert-bell";
// Componentes globais, casca da app e utilitários permanecem normais (síncronos)
import { AppMenu } from "@/widgets/app-menu";

//  IMPORTS DINÂMICOS (Lazy Loading): O código só é baixado sob demanda.
// Nota: Certifique-se de que os seus ficheiros index exportam estes componentes como default.
// Se forem Named Exports (export function ...), mude na página para default ou adapte a Promise.
const PdvPage = React.lazy(() => import("@/pages/pdv").then((m) => ({ default: m.PdvPage })));
const ManagerApp = React.lazy(() =>
  import("@/pages/manager").then((m) => ({ default: m.ManagerApp }))
);
const KitchenDisplay = React.lazy(() =>
  import("@/pages/kitchen").then((m) => ({ default: m.KitchenDisplay }))
);
const CourierApp = React.lazy(() =>
  import("@/pages/courier").then((m) => ({ default: m.CourierApp }))
);
const CashierApp = React.lazy(() =>
  import("@/pages/cashier").then((m) => ({ default: m.CashierApp }))
);
const CustomerMenuPage = React.lazy(() =>
  import("@/pages/customer-menu").then((m) => ({ default: m.CustomerMenuPage }))
);
const LoginPage = React.lazy(() => import("@/pages/login").then((m) => ({ default: m.LoginPage })));
// Fallback da identidade centralizada (docs/26 §2, decisão 5): a tela de PIN
// anterior vira rota funcional de emergência, fora do AppFrame como o login.
const LoginPagePin = React.lazy(() =>
  import("@/pages/login").then((m) => ({ default: m.LoginPagePin }))
);
const ResetPasswordPage = React.lazy(() =>
  import("@/pages/login").then((m) => ({ default: m.ResetPasswordPage }))
);
const ProfilePage = React.lazy(() => import("@/pages/manager/tabs/profile/ProfilePage"));

// Feedback visual simples enquanto o pedaço do app está a ser descarregado
const LoadingFallback = () => (
  <div className="flex h-screen w-screen items-center justify-center bg-background text-sm font-medium text-text-secondary animate-pulse">
    A carregar módulo...
  </div>
);

export function AppFrame({ children }) {
  const { logout, storeSettings } = useAuth();
  const { drawerOpen, openDrawer } = useNav();

  const menuSections = useMenuSections();
  const totalMenuItems = React.useMemo(
    () => menuSections.flatMap((s) => s.items).length,
    [menuSections]
  );

  const singleItem = totalMenuItems === 1;

  return (
    <div className="relative min-h-screen">
      <div className="sticky top-0 z-40 h-14 flex items-center gap-2 px-3 sm:px-4 bg-surface/95 backdrop-blur border-b border-border">
        {!singleItem && (
          <button
            type="button"
            onClick={openDrawer}
            aria-label="Abrir menu"
            aria-expanded={drawerOpen}
            aria-controls="app-menu-painel"
            className="lg:hidden w-10 h-10 -ml-1 flex items-center justify-center rounded-full text-text-secondary hover:text-foreground transition-colors shrink-0"
          >
            <Menu size={20} />
          </button>
        )}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {storeSettings?.logoUrl ? (
            <div className="h-9 w-9 rounded-full bg-surface-overlay border border-border flex items-center justify-center overflow-hidden shrink-0">
              <img
                src={storeSettings.logoUrl}
                alt="Logo do restaurante"
                className="w-full h-full object-contain"
              />
            </div>
          ) : (
            <div className="h-9 w-9 rounded-full bg-surface-overlay border border-border flex items-center justify-center text-text-muted shrink-0">
              <span className="text-xs font-bold">{storeSettings?.merchantName?.[0] ?? "B"}</span>
            </div>
          )}
          <span className="text-sm font-semibold text-text-secondary truncate">
            {storeSettings?.merchantName ?? "PDV"}
          </span>
        </div>
        <ThemeToggle />
        <AlertBell />
        {singleItem && (
          <button
            type="button"
            onClick={logout}
            aria-label="Sair"
            title="Sair"
            className="w-10 h-10 -mr-1 flex items-center justify-center rounded-full text-text-secondary hover:text-foreground hover:bg-surface-overlay/60 transition-colors shrink-0"
          >
            <LogOut size={20} />
          </button>
        )}
      </div>
      <div className="flex items-start">
        {!singleItem && <AppMenu />}
        {/* O Suspense aqui garante o carregamento dinâmico das telas internas por papel do utilizador */}
        <main className="flex-1 min-w-0">
          <Suspense fallback={<LoadingFallback />}>{children}</Suspense>
        </main>
      </div>
    </div>
  );
}

// Mapa de ecrãs por papel (renderizados dentro do Suspense do AppFrame)
const SCREENS_BY_ROLE = {
  waiter: <PdvPage />,
  manager: <ManagerApp />,
  kitchen: <KitchenDisplay />,
  courier: <CourierApp />,
  cashier: <CashierApp />,
};

// /login/pin: fallback da tela antiga de PIN. Com sessão ativa não faz sentido
// pedir PIN de novo — manda para a tela do papel (o "trocar de empresa" é logout).
function PinLoginRoute() {
  const { session, booting } = useAuth();
  if (booting) return <div className="min-h-screen bg-background" />;
  if (session) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <LoginPagePin />
    </Suspense>
  );
}

export function Root() {
  const { session, booting } = useAuth();
  const location = useLocation();

  if (booting) {
    return <div className="min-h-screen bg-background" />;
  }

  if (!session) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <LoginPage />
      </Suspense>
    );
  }

  if (location.pathname === "/manager/profile") {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <ProfilePage />
      </Suspense>
    );
  }

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
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* Pública, sem login */}
          <Route path="/pedido/*" element={<CustomerMenuPage />} />
          {/* Identidade centralizada (docs/26): o reset chega por link de e-mail,
              então é pública e não passa pelo AuthProvider. */}
          <Route
            path="/reset-password"
            element={
              <Suspense fallback={<LoadingFallback />}>
                <ResetPasswordPage />
              </Suspense>
            }
          />
          {/* Fallback histórico: login por PIN (docs/26 §2, decisão 5) */}
          <Route
            path="/login/pin"
            element={
              <AuthProvider>
                <PinLoginRoute />
              </AuthProvider>
            }
          />
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
      </Suspense>
    </BrowserRouter>
  );
}
