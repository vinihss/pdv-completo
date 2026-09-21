import React from "react";
import { AlertTriangle } from "lucide-react";

export default function ConfirmModal({ title, message, confirmLabel, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="w-full max-w-xs bg-stone-900 border border-stone-800 rounded-2xl p-5 fade-up">
        <div className="flex items-center gap-2 text-amber-400 mb-3">
          <AlertTriangle size={18} />
          <span className="font-semibold text-sm">{title}</span>
        </div>
        <p className="text-stone-400 text-sm mb-5">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-2.5 rounded-xl">Cancelar</button>
          <button onClick={onConfirm} className="flex-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-2.5 rounded-xl">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}