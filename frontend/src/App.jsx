import React from "react";
import { AppRouter } from "@/app/router.jsx";
import { AppConfigProvider } from "@/app/providers/app-config";
import { BootGate } from "@/app/boot/BootGate.jsx";
import { NetworkStatusBanner } from "@/shared/components";

export default function App() {
  // AppConfigProvider diz onde está a API; BootGate (só no desktop) verifica
  // atualizações e a conectividade antes de deixar o app abrir.
  return (
    <AppConfigProvider>
      <BootGate>
        <NetworkStatusBanner />
        <AppRouter />
      </BootGate>
    </AppConfigProvider>
  );
}
