import React, { useId } from "react";
import { ChevronDown } from "lucide-react";

export const inputClass =
  "w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-amber-500/50";

// `onToggle` opcional transforma o cabeçalho em botão de colapso (accordion
// de seções — ex.: categorias do catálogo). Sem ele, a seção é estática.
export function Section({ title, children, collapsed, onToggle }) {
  const header = (
    <div className="text-stone-500 text-xs font-bold tracking-widest uppercase mb-3 flex items-center gap-1.5">
      {title}
      {onToggle && (
        <ChevronDown size={13} className={`transition-transform ${collapsed ? "-rotate-90" : ""}`} />
      )}
    </div>
  );
  return (
    <div>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="w-full text-left hover:text-stone-400 transition-colors"
        >
          {header}
        </button>
      ) : (
        header
      )}
      {!collapsed && <div className="bg-stone-900 border border-stone-800 rounded-2xl p-4 space-y-4">{children}</div>}
    </div>
  );
}

export function Field({ label, required, children }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-stone-400 text-xs font-medium mb-1.5 block">
        {label}
        {required && <span className="text-red-400 ml-0.5" aria-hidden="true">*</span>}
      </label>
      {React.isValidElement(children) ? React.cloneElement(children, { id, required }) : children}
    </div>
  );
}

export function ToggleRow({ label, checked, onChange }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`w-11 h-6 rounded-full transition-colors relative ${checked ? "bg-amber-500" : "bg-stone-700"}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}