import React from "react";

export const inputClass =
  "w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-amber-500/50";

export function Section({ title, children }) {
  return (
    <div>
      <div className="text-stone-500 text-xs font-bold tracking-widest uppercase mb-3">{title}</div>
      <div className="bg-stone-900 border border-stone-800 rounded-2xl p-4 space-y-4">{children}</div>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div>
      <div className="text-stone-400 text-xs font-medium mb-1.5">{label}</div>
      {children}
    </div>
  );
}

export function ToggleRow({ label, checked, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={`w-11 h-6 rounded-full transition-colors relative ${checked ? "bg-amber-500" : "bg-stone-700"}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}