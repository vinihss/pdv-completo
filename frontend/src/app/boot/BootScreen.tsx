import { RefreshCcw, WifiOff } from "lucide-react";
import React from "react";

/**
 * Tela de bloqueio do boot: o app não conseguiu abrir porque o sistema não
 * respondeu. Fullscreen de propósito — é um estado terminal (não dá para
 * operar o PDV sem a API), então não há como "continuar por baixo".
 */
export default function BootScreen({ title, message, hint, address, onRetry, retrying, action }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center space-y-6">
        <div className="flex justify-center text-text-muted">
          <WifiOff size={32} />
        </div>

        <div className="space-y-2">
          <h1 className="text-base font-semibold text-foreground">{title}</h1>
          <p className="text-sm text-text-secondary">{message}</p>
          {hint && <p className="text-xs text-text-muted">{hint}</p>}
        </div>

        {address && (
          <p className="text-[11px] text-text-muted font-mono break-all px-3 py-2 rounded-lg bg-surface/60">
            {address}
          </p>
        )}

        <div className="space-y-2">
          <button
            onClick={onRetry}
            disabled={retrying}
            className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-strong disabled:opacity-50 text-primary-foreground font-semibold py-3 rounded-xl transition-colors"
          >
            <RefreshCcw size={15} className={retrying ? "animate-spin" : ""} />
            {retrying ? "Tentando de novo…" : "Tentar de novo"}
          </button>
          {action}
        </div>
      </div>
    </div>
  );
}
