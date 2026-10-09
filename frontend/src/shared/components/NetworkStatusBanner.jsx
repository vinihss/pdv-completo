import React from "react";
import { WifiOff } from "lucide-react";
import { useNetworkStatus } from "@/shared/hooks";

/**
 * Banner que aparece quando o sistema está offline.
 * Aparece fixo no topo da tela com alerta vermelho.
 */
export default function NetworkStatusBanner() {
  const { isOnline } = useNetworkStatus();

  if (isOnline) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-0 left-0 right-0 z-50 bg-red-600 text-white px-4 py-2 shadow-lg flex items-center justify-center gap-2"
    >
      <WifiOff size={18} aria-hidden="true" />
      <span className="text-sm font-semibold">Sem conexão com a internet</span>
    </div>
  );
}
