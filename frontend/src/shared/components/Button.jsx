import React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/shared/lib";

// Variantes centrais do Button. Fonte única para botões: altere aqui, não
// espalhe classes de botão por pages/features. Os valores iniciais são idênticos
// ao comportamento anterior (tailwind-merge deduplica sobrescritas por className).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors active:scale-[.98] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary-strong",
        secondary: "border border-border bg-surface-overlay text-text-secondary hover:bg-surface-overlay",
        danger: "bg-danger-fill text-danger-foreground hover:bg-danger-fill-strong",
        ghost: "text-text-secondary hover:bg-surface-overlay hover:text-foreground",
      },
      size: {
        sm: "min-h-10 px-3 py-2 text-sm",
        md: "min-h-11 px-4 py-2.5 text-sm",
        lg: "min-h-12 px-5 py-3 text-base",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

/** Botão compartilhado: mantém altura tátil e estados coerentes entre telas. */
export default function Button({ variant, size, type = "button", className, children, ...props }) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props}>
      {children}
    </button>
  );
}

export { buttonVariants };
