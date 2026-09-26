import React from "react";
import { useToast, Toast } from "@/shared/components";
import { CashDrawerTab } from "@/widgets/cash-drawer";

// App do perfil "caixa": tela única de operação do fluxo de caixa
// (abertura, sangria, suprimento e fechamento).
export default function CashierApp() {
  const { toast, showToast } = useToast();
  return (
    <div className="min-h-screen bg-stone-950 text-stone-50">
      <CashDrawerTab showToast={showToast} />
      <Toast toast={toast} />
    </div>
  );
}