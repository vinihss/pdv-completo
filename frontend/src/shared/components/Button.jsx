import React from "react";

const VARIANTS = {
  primary: "bg-amber-500 text-stone-950 hover:bg-amber-400",
  secondary: "border border-stone-700 bg-stone-800 text-stone-200 hover:bg-stone-700",
  danger: "bg-red-500 text-white hover:bg-red-400",
  ghost: "text-stone-300 hover:bg-stone-800 hover:text-stone-100",
};
const SIZES = {
  sm: "min-h-10 px-3 py-2 text-sm",
  md: "min-h-11 px-4 py-2.5 text-sm",
  lg: "min-h-12 px-5 py-3 text-base",
};

/** Botão compartilhado: mantém altura tátil e estados coerentes entre telas. */
export default function Button({
  variant = "primary",
  size = "md",
  type = "button",
  className = "",
  children,
  ...props
}) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors active:scale-[.98] disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant] ?? VARIANTS.primary} ${SIZES[size] ?? SIZES.md} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
