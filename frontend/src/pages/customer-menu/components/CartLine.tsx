import { missingRequiredGroups, variationGroups } from "@/entities/cart";
import { formatBRL, variationsText } from "@/shared/lib";
import { Minus, Plus } from "lucide-react";
import React from "react";

// ---------------------------------------------------------------------------
// Linha de carrinho (usada na tela do carrinho no celular e no painel lateral
// do desktop) — mesma peça, dois contextos.
export default function CartLine({
  it,
  addToCartLine,
  removeFromCartLine,
  onNotesChange,
  openNote,
  setOpenNote,
  onEditLine,
  hasVariations,
}) {
  // Linha incompleta (só acontece com carrinho resgatado do servidor, feito por
  // versão anterior da tela ou enviado direto pra API): o backend rejeitaria
  // no checkout com 422, então avisamos aqui e oferecemos a correção.
  const missing = hasVariations
    ? missingRequiredGroups(variationGroups(it), it.selectedVariations)
    : [];
  return (
    <div className="py-3 border-b border-border last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14.5px] font-semibold text-foreground">{it.name}</p>
          <p className="text-[13px] text-text-muted mt-0.5">{formatBRL(it.price)} cada</p>
          {variationsText(it.selectedVariations) && (
            <p className="text-[12.5px] text-text-secondary mt-0.5">
              {variationsText(it.selectedVariations)}
            </p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2.5 bg-surface border border-border rounded-full px-1 py-1">
          <button
            onClick={() => removeFromCartLine(it.key)}
            className="w-7 h-7 flex items-center justify-center"
            aria-label="Diminuir quantidade"
          >
            <Minus size={14} />
          </button>
          <span className="text-[13.5px] font-semibold w-4 text-center text-foreground">
            {it.quantity}
          </span>
          <button
            onClick={() => addToCartLine(it.key)}
            className="w-7 h-7 flex items-center justify-center"
            aria-label="Aumentar quantidade"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        {hasVariations && (
          <button onClick={() => onEditLine(it)} className="text-[12px] font-medium text-primary">
            {variationsText(it.selectedVariations) ? "Alterar opções" : "Escolher opções"}
          </button>
        )}
        {missing.length > 0 && (
          <span className="text-[12px] font-medium text-destructive">
            Falta escolher: {missing.join(", ")}
          </span>
        )}
        <button
          onClick={() => setOpenNote(openNote === it.key ? null : it.key)}
          className="text-[12px] font-medium text-primary"
        >
          {it.notes?.trim() ? "Editar observação" : "+ Adicionar observação"}
        </button>
      </div>
      {openNote === it.key && (
        <textarea
          value={it.notes ?? ""}
          onChange={(e) => onNotesChange(it.key, e.target.value)}
          placeholder="Ex.: sem cebola, capricha no queijo..."
          rows={2}
          className="mt-2 w-full bg-surface border border-border rounded-lg px-3 py-2 text-[13.5px] text-foreground outline-none focus:border-ring"
        />
      )}
    </div>
  );
}

// Coluna lateral do desktop: o carrinho fica sempre visível enquanto o cliente
