import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LogOut } from "lucide-react";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import Login from "./screens/Login.jsx";
import WaiterApp from "./screens/WaiterApp.jsx";
import KitchenDisplay from "./screens/KitchenDisplay.jsx";
import ManagerApp from "./screens/ManagerApp.jsx";
import CourierApp from "./screens/CourierApp.jsx";
import CustomerMenuPage from "./screens/CustomerMenuPage.jsx";

function AppFrame({ children }) {
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

function Root() {
  const { session, booting } = useAuth();

  if (booting) {
    return <div className="min-h-screen bg-stone-950" />;
  }

  if (!session) {
    return <Login />;
  }

  const screensByRole = {
    waiter: <WaiterApp />,
    manager: <ManagerApp />,
    kitchen: <KitchenDisplay />,
    courier: <CourierApp />,
  };

  return <AppFrame>{screensByRole[session.user.role]}</AppFrame>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Pública, sem login — cliente final, chega direto ou pelo link do bot (§04/05) */}
        <Route path="/pedido/*" element={<CustomerMenuPage />} />
        {/* Tudo mais continua exatamente como era: exige login, roteado por papel */}
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
