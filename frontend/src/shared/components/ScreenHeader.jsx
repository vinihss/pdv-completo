import React from "react";
import { ChevronLeft, X } from "lucide-react";
import useEscapeLayer from "@/shared/hooks/useEscapeLayer.js";

/**
 * Cabeçalho das telas que já são de tela cheia (lançar item, detalhe da
 * comanda). Mesma métrica do `Modal` — mesma altura, mesma tipografia, mesma
 * borda — mas o controle fica à **esquerda**: em tela ele é navegação (voltar
 * para a comanda), não descarte. Descarte é o X à direita do `Modal`.
 *
 * Esc fecha a tela com a mesma semântica do `Modal` (pilha de camadas em
 * `useEscapeLayer`): um modal aberto por cima continua sendo o único a reagir.
 */
export default function ScreenHeader({ title, subtitle, onBack, backLabel = "Voltar", backIcon = "chevron", right }) {
  const layerRef = useEscapeLayer(onBack);

  return (
    <header ref={layerRef} className="shrink-0 flex items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 border-b border-stone-800">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel}
          className="w-10 h-10 -ml-2 flex items-center justify-center rounded-full text-stone-400 hover:text-stone-200 transition-colors shrink-0"
        >
          {backIcon === "close" ? <X size={20} /> : <ChevronLeft size={22} />}
        </button>
      )}
      <div className="flex-1 min-w-0">
        <h1 className="font-display text-lg font-bold leading-tight truncate">{title}</h1>
        {subtitle && <p className="text-stone-500 text-xs truncate">{subtitle}</p>}
      </div>
      {right}
    </header>
  );
}
