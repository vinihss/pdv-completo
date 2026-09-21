import React, { useState } from "react";
import { X } from "lucide-react";

export default function VariationModal({ product, onClose, onConfirm }) {
  const [selected, setSelected] = useState({}); // groupName -> string | string[]
  const [missing, setMissing] = useState([]); // group names obrigatórios sem seleção

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
    const missingGroups = product.variations.filter((g) => g.required && !isSatisfied(g));
    if (missingGroups.length > 0) {
      setMissing(missingGroups.map((g) => g.name));
      return;
    }
    const sel = {};
    for (const g of product.variations) {
      const v = selected[g.name];
      if (v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      sel[g.name] = v;
    }
    onConfirm(sel);
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-sm bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 max-h-[85vh] overflow-y-auto fade-up">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">{product.name}</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="space-y-4">
          {product.variations.map((g) => (
            <div key={g.name}>
              <div className="text-sm font-semibold mb-2 flex items-center gap-1">
                {g.name}
                {g.required && <span className="text-amber-400">*</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {g.options.map((opt) => {
                  const active = isSelected(g, opt);
                  return (
                    <button
                      key={opt}
                      onClick={() => toggleOption(g, opt)}
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
        </div>
        <button
          onClick={handleConfirm}
          className="w-full bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-3 rounded-xl mt-5"
        >
          Adicionar
        </button>
      </div>
    </div>
  );
}