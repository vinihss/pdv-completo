import { useState, useRef, useCallback } from "react";

export function useToast() {
  const [toast, setToastState] = useState(null);
  const timer = useRef(null);

  const showToast = useCallback((msg, kind = "info") => {
    setToastState({ msg, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToastState(null), 2600);
  }, []);

  return { toast, showToast };
}

export function Toast({ toast }) {
  if (!toast) return null;
  const kindClass =
    toast.kind === "error"
      ? "border-red-500/50 bg-red-950/90 text-red-100"
      : toast.kind === "success"
      ? "border-emerald-500/50 bg-emerald-950/90 text-emerald-100"
      : "border-stone-700 bg-stone-800";
  return (
    <div
      className={`fixed top-4 left-1/2 -translate-x-1/2 border px-5 py-3 rounded-xl shadow-2xl z-[80] text-sm font-semibold toast-anim ${kindClass}`}
    >
      {toast.msg}
    </div>
  );
}
