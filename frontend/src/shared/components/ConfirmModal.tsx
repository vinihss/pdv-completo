import useEscapeLayer from "@/shared/hooks/useEscapeLayer.js";
import { AlertTriangle } from "lucide-react";
import React from "react";
import Button from "./Button.jsx";

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 p-6"
    >
      <div className="fade-up w-full max-w-xs rounded-2xl border border-border bg-surface p-5">
        <div
          className={`flex items-center gap-2 mb-3 ${destructive ? "text-destructive" : "text-primary"}`}
        >
          <AlertTriangle size={18} aria-hidden="true" />
          <span className="font-semibold text-sm">{title}</span>
        </div>
        <p className="text-text-secondary text-sm mb-5">{message}</p>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            className="flex-1"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
