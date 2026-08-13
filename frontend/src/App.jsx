import React from "react";
import { LogOut } from "lucide-react";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import Login from "./screens/Login.jsx";
import WaiterApp from "./screens/WaiterApp.jsx";
import KitchenDisplay from "./screens/KitchenDisplay.jsx";
import ManagerApp from "./screens/ManagerApp.jsx";

function AppFrame({ children }) {
  const { session, logout } = useAuth();
  return (
    <div className="relative">
      {children}
      <button
        onClick={logout}
        className="fixed bottom-4 right-4 z-20 flex items-center gap-2 bg-stone-800/95 backdrop-blur border border-stone-700 hover:bg-stone-700 text-stone-200 text-xs font-semibold pl-3 pr-3.5 py-2.5 rounded-full shadow-lg shadow-black/40"
      >
        <LogOut size={14} />
        Trocar usuário
        <span className="text-stone-500 font-normal hidden sm:inline">· {session.user.name.split(" ")[0]}</span>
      </button>
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
  };

  return <AppFrame>{screensByRole[session.user.role]}</AppFrame>;
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}
