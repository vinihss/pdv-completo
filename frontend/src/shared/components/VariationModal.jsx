import React, { useEffect, useState } from "react";
import { X, Minus, Plus } from "lucide-react";
import { money } from "../lib/money.js";

/**
 * Seleção de variações de um produto — compartilhado entre o lançamento do
 * garçom (features/orders/AddItemScreen) e o cardápio público do cliente
 * (features/customer-menu). Ambos consomem o mesmo payload: `product.variations`
 * no formato `[{ name, options, required?, allowMultiple? }]`.
 *
 * Sheet de baixo no celular, card centralizado a partir de `sm` (o cliente
 * chega pelo WhatsApp, metade dos acessos é desktop).
 *
 * `onConfirm(selectedVariations, notes, quantity)` — `notes` só chega preenchido
 * quando o chamador liga `allowNotes` (página pública deixa o cliente
 * Observation no ato; no garçom a observação fica na revisão do carrinho, sem
 * duplicar campo). `quantity` só é usado quando `showQuantity` está ligado.
 *
 * `imagePath` + `showQuantity` transformam o modal na ficha completa do produto
 * (foto grande, quantidade e total no botão) — é o que a página pública abre
 * antes de jogar no carrinho. Ambos desligados por padrão: o garçom continua
 * vendo só as opções.
 */
export default function VariationModal({
  product,
  price,
  onClose,
  onConfirm,
  allowNotes = false,
  confirmLabel = "Adicionar",
  initialSelected = null, // null = novo item; objeto = edição de linha já escolhida
  initialNotes = "",
  imagePath = null, // ficha completa: foto grande no topo
  showQuantity = false, // ficha completa: quantidade antes de adicionar
  initialQuantity = 1,
}) {
  const groups = product.variations ?? [];
  // groupName -> string | string[]
  const [selected, setSelected] = useState(initialSelected ?? {});
  const [missing, setMissing] = useState([]); // groups obrigatórios sem seleção
  const [notes, setNotes] = useState(initialNotes);
  const [qty, setQty] = useState(Math.max(1, initialQuantity));

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggleOption(group, option) {
    setSelected((prev) => {
      const current = prev[group.name];
      if (group.allowMultiple) {
        const arr = Array.isArray(current) ? current : [];
        const next = arr.includes(option) ? arr.filter((o) => o !== option) : [...arr, option];
        return { ...prev, [group.name]: next };
      }
      return { ...prev, [group.name]: current === option ? undefined : option };
    });
  }

  function isSelected(group, option) {
    const v = selected[group.name];
    return Array.isArray(v) ? v.includes(option) : v === option;
  }

  function isSatisfied(group) {
    if (!group.required) return true;
    const v = selected[group.name];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  }

  function handleConfirm() {
    const missingGroups = groups.filter((g) => g.required && !isSatisfied(g));
    if (missingGroups.length > 0) {
      setMissing(missingGroups.map((g) => g.name));
      return;
    }
    // Só grupos efetivamente escolhidos entram na linha — evita gravar
    // `{grupo: undefined}` (que quebraria a chave da linha no carrinho).
    const sel = {};
    for (const g of groups) {
      const v = selected[g.name];
      if (v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      sel[g.name] = v;
    }
    // qty só entra na assinatura quando a ficha tem controle de quantidade —
    // o garçom (e os testes dele) continuam com onConfirm(sel, notes).
    onConfirm(sel, notes.trim() || undefined, ...(showQuantity ? [qty] : []));
  }

  const total = typeof price === "number" ? price * qty : null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Opções de ${product.name}`}
        className="w-full sm:max-w-sm bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl max-h-[88vh] overflow-y-auto fade-up"
      >
        {/* ficha completa: foto grande, com o nome/preço logo abaixo */}
        {imagePath && (
          <div className="relative">
            <img src={imagePath} alt={product.name} className="w-full aspect-[16/10] object-cover" />
            <button
              onClick={onClose}
              className="absolute top-3 right-3 w-8 h-8 rounded-full bg-stone-950/70 flex items-center justify-center text-stone-300 hover:text-stone-100"
              aria-label="Fechar"
            >
              <X size={17} />
            </button>
          </div>
        )}

        <div className="p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-bold leading-tight">{product.name}</h3>
            {typeof price === "number" && <p className="text-amber-400 font-semibold text-sm mt-0.5">{money(price)}</p>}
            {product.description && <p className="text-stone-400 text-[13px] mt-1 leading-snug">{product.description}</p>}
          </div>
          {!imagePath && (
            <button onClick={onClose} className="text-stone-500 shrink-0 hover:text-stone-300" aria-label="Fechar">
              <X size={20} />
            </button>
          )}
        </div>

        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="text-sm font-semibold mb-2 flex items-center gap-1">
                {g.name}
                {g.required && <span className="text-amber-400">*</span>}
                {g.allowMultiple && !g.required && <span className="text-stone-500 text-xs font-normal">(vários)</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {g.options.map((opt) => {
                  const active = isSelected(g, opt);
                  return (
                    <button
                      key={opt}
                      onClick={() => toggleOption(g, opt)}
                      aria-pressed={active}
                      className={`px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                        active
                          ? "bg-amber-500 border-amber-500 text-stone-950"
                          : "bg-stone-800 border-stone-700 text-stone-200"
                      } ${missing.includes(g.name) && !isSatisfied(g) ? "border-red-500/70" : ""}`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
              {missing.includes(g.name) && !isSatisfied(g) && (
                <div className="text-red-400 text-xs mt-1">Selecione uma opção obrigatória.</div>
              )}
            </div>
          ))}

          {showQuantity && (
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-sm font-semibold">Quantidade</span>
              <div className="flex items-center gap-3 bg-stone-950 border border-stone-800 rounded-full px-1.5 py-1">
                <button
                  onClick={() => setQty((q) => Math.max(1, q - 1))}
                  disabled={qty <= 1}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-stone-200 disabled:opacity-30"
                  aria-label={`Diminuir quantidade de ${product.name}`}
                >
                  <Minus size={15} />
                </button>
                <span className="w-5 text-center text-[14px] font-bold">{qty}</span>
                <button
                  onClick={() => setQty((q) => q + 1)}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-stone-200"
                  aria-label={`Aumentar quantidade de ${product.name}`}
                >
                  <Plus size={15} />
                </button>
              </div>
            </div>
          )}

          {allowNotes && (
            <div>
              <div className="text-sm font-semibold mb-2">Observação <span className="text-stone-500 text-xs font-normal">(opcional)</span></div>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Ex.: sem cebola, capricha no molho..."
                className="w-full bg-stone-950 border border-stone-800 rounded-lg px-3 py-2 text-[13.5px] text-stone-100 outline-none focus:border-amber-500 placeholder:text-stone-600"
              />
            </div>
          )}
        </div>

        <button
          onClick={handleConfirm}
          className="w-full bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-3 rounded-xl mt-5"
        >
          <span>{confirmLabel}</span>
          {showQuantity && total !== null && (
            <span> · {money(total)}</span>
          )}
        </button>
        </div>
      </div>
    </div>
  );
}
