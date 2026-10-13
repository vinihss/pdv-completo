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
      ? "border-destructive/50 bg-warning/10 text-text-secondary"
      : toast.kind === "success"
      ? "border-success/50 bg-warning/10 text-text-secondary"
      : "border-border bg-surface-overlay";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-4 left-1/2 -translate-x-1/2 border px-5 py-3 rounded-xl shadow-2xl z-[80] text-sm font-semibold toast-anim ${kindClass}`}
    >
      {toast.msg}
    </div>
  );
}
