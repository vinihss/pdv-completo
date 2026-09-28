import React from "react";
import { ChefHat, Bike } from "lucide-react";
import { Modal } from "@/shared/components";

const LAYOUTS = [
  { id: "kitchen", label: "Cozinha", description: "Ticket de produção para a cozinha", icon: ChefHat },
  { id: "courier", label: "Entrega", description: "Ticket com endereço para o entregador", icon: Bike },
];

export default function PrintLayoutModal({ onClose, onPrint, busy }) {
  return (
    <Modal title="Imprimir pedido" onClose={onClose}>
      <div className="p-5 space-y-3">
        <p className="text-stone-400 text-sm">Escolha o layout de impressão:</p>
        {LAYOUTS.map((layout) => {
          const Icon = layout.icon;
          return (
            <button
              key={layout.id}
              onClick={() => onPrint(layout.id)}
              disabled={busy}
              className="w-full flex items-center gap-3 bg-stone-800/60 hover:bg-stone-800 border border-stone-700 rounded-xl px-4 py-3.5 text-left transition-colors disabled:opacity-50"
            >
              <Icon size={20} className="text-amber-500 shrink-0" />
              <div>
                <div className="font-semibold text-sm">{layout.label}</div>
                <div className="text-stone-500 text-xs mt-0.5">{layout.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
