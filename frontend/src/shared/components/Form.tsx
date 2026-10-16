import React, { useId } from "react";

export const inputClass =
  "w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/50";

export function Section({ title, children }) {
  return (
    <div>
      <div className="text-text-muted text-xs font-bold tracking-widest uppercase mb-3">
        {title}
      </div>
      <div className="bg-surface border border-border rounded-2xl p-4 space-y-4">{children}</div>
    </div>
  );
}

export function Field({ label, required, children }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-text-secondary text-xs font-medium mb-1.5 block">
        {label}
        {required && (
          <span className="text-destructive ml-0.5" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {React.isValidElement(children) ? React.cloneElement(children, { id, required }) : children}
    </div>
  );
}

export function ToggleRow({ label, checked, onChange }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`w-11 h-6 rounded-full transition-colors relative ${checked ? "bg-primary" : "bg-surface-overlay"}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-foreground transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}
