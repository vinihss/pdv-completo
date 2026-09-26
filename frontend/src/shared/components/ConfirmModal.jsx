import React from "react";
import { AlertTriangle } from "lucide-react";
import useEscapeLayer from "@/shared/hooks/useEscapeLayer.js";

/**
 * Confirmação curta ("Remover item?", "Excluir categoria?"). Mantém o card
 * centralizado em vez de virar tela cheia: a decisão é binária e o peso do
 * aviso vem do card pequeno, não de uma tela inteira.
 *
 * `destructive` pinta a confirmação de vermelho (exclusão/cancelamento).
 * Esc equivale a cancelar.
 */
export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
  destructive = false,
}) {
  const layerRef = useEscapeLayer(onCancel);

  return (
    <div
      ref={layerRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6"
    >
      <div className="w-full max-w-xs bg-stone-900 border border-stone-800 rounded-2xl p-5 fade-up">
        <div className={`flex items-center gap-2 mb-3 ${destructive ? "text-red-400" : "text-amber-400"}`}>
          <AlertTriangle size={18} />
          <span className="font-semibold text-sm">{title}</span>
        </div>
        <p className="text-stone-400 text-sm mb-5">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-2.5 rounded-xl">
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 text-stone-950 font-semibold py-2.5 rounded-xl ${
              destructive ? "bg-red-500 hover:bg-red-400" : "bg-amber-500 hover:bg-amber-400"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
