import React from "react";
import { Loader2 } from "lucide-react";

/**
 * Splash do boot: tela cheia com o que o app está fazendo naquele instante.
 *
 * A barra é determinística quando há download (percentual do update) e
 * indeterminada (spinner) enquanto o app espera rede — nas duas situações o
 * gerente vê que o programa está vivo, e não uma tela travada.
 */
export default function BootSplash({ title, detail, percent, address, note, action }) {
  const hasPercent = typeof percent === "number";

  return (
    <div className="min-h-screen bg-stone-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center space-y-6">
        <div className="flex justify-center">
          <div className="h-16 w-16 rounded-2xl bg-amber-500 text-stone-950 flex items-center justify-center text-lg font-black">
            PDV
          </div>
        </div>

        <div className="space-y-1">
          <h1 className="text-base font-semibold text-stone-100">{title}</h1>
          {detail && <p className="text-sm text-stone-500">{detail}</p>}
        </div>

        {hasPercent ? (
          <div>
            <div
              role="progressbar"
              aria-label="Progresso da atualização"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-2 w-full rounded-full bg-stone-800 overflow-hidden"
            >
              <div
                className="h-full bg-amber-500 transition-[width] duration-200 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-stone-500 tabular-nums">{percent}%</p>
          </div>
        ) : (
          <div className="flex justify-center text-stone-600">
            <Loader2 size={18} className="animate-spin" />
          </div>
        )}

        {note && <p className="text-xs text-amber-500/90">{note}</p>}

        {address && (
          <p className="text-[11px] text-stone-700 font-mono break-all">{address}</p>
        )}

        {action}
      </div>
    </div>
  );
}
