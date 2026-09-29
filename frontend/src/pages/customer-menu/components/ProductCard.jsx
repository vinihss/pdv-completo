import React, { useState } from "react";
import { formatBRL, variationsText } from "@/shared/lib";
import { Minus, Plus } from "lucide-react";
import { linesOfProduct, lineKey, productQty } from "@/entities/cart";
import { assetUrl } from "@/shared/lib/server";

// Card de linha das categorias: um produto abaixo do outro, foto à direita
// (texto ocupa a largura restante). Sem botão de "+": o clique no card abre a
// ficha completa do produto antes de adicionar. O que aparece aqui é o que já
// está no carrinho — as linhas com variação, que o cliente ajusta sem reabrir
// a ficha.
export default function ProductCard({ product, cart, onOpen, onInc, onDec, onEditLine }) {
  const [expanded, setExpanded] = useState(false);
  const qty = productQty(cart, product.id);
  // Linha simples não vira linha aqui: ela é só a contagem do badge.
  const extraLines = linesOfProduct(cart, product.id).filter((l) => l.key !== lineKey(product.id, {}));
  const shown = expanded ? extraLines : extraLines.slice(0, 2);
  const groups = product.variations ?? [];

  return (
    <div className="flex items-start gap-3 py-3 border-b border-stone-800/60 last:border-0 rounded-lg cursor-pointer transition-colors hover:bg-stone-900/40">
      <div className="min-w-0 flex-1">
        <button onClick={() => onOpen(product)} className="block w-full text-left" aria-label={`Ver ${product.name}`}>
          <p className="text-[14.5px] font-semibold leading-tight text-stone-50">{product.name}</p>
          {product.description && (
            <p className="text-[11.5px] text-stone-500 leading-snug mt-0.5 line-clamp-2">{product.description}</p>
          )}
          {groups.length > 0 && (
            <p className="text-[11px] text-amber-400/90 mt-1">
              {groups.length === 1 ? "Opções disponíveis" : `${groups.length} grupos de opções`}
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[13.5px] text-amber-400 font-semibold">{formatBRL(product.price)}</span>
            {qty > 0 && <span className="text-[11px] text-stone-500">{qty} no carrinho</span>}
          </div>
        </button>

        {extraLines.length > 0 && (
          <ul className="mt-2 space-y-1">
            {shown.map((l) => {
              const rotuloLinha = variationsText(l.selectedVariations) || "Padrão";
              return (
                <li key={l.key} className="flex items-center justify-between gap-2 bg-stone-950/60 rounded-lg px-2 py-1.5">
                  <button onClick={() => onEditLine?.(l)} className="text-[11.5px] text-stone-400 truncate text-left hover:text-stone-300">
                    {rotuloLinha}
                  </button>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {/* O rótulo da linha entra no aria-label: um produto com 3
                        variações escolhidas geraria 3 botões "Aumentar" iguais. */}
                    <button
                      onClick={() => onDec(l.key)}
                      className="w-5 h-5 flex items-center justify-center text-stone-400"
                      aria-label={`Diminuir ${product.name} — ${rotuloLinha}`}
                    >
                      <Minus size={12} />
                    </button>
                    <span className="text-[11.5px] font-semibold w-3 text-center">{l.quantity}</span>
                    <button
                      onClick={() => onInc(l.key)}
                      className="w-5 h-5 flex items-center justify-center text-stone-400"
                      aria-label={`Aumentar ${product.name} — ${rotuloLinha}`}
                    >
                      <Plus size={12} />
                    </button>
                  </span>
                </li>
              );
            })}
            {extraLines.length > shown.length && (
              <li>
                <button onClick={() => setExpanded(true)} className="text-[11.5px] text-amber-400 font-medium pl-1">
                  +{extraLines.length - shown.length} outra{extraLines.length - shown.length > 1 ? "s" : ""}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="relative shrink-0">
        {product.imagePath ? (
          <img src={assetUrl(product.imagePath)} alt={product.name} className="w-20 h-20 rounded-lg object-cover" loading="lazy" />
        ) : (
          <div className="w-20 h-20 rounded-lg bg-stone-800 flex items-center justify-center text-stone-600 font-display text-lg font-bold">
            {(product.name?.[0] ?? "?").toUpperCase()}
          </div>
        )}
      </div>
    </div>
  );
}
