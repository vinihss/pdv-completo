import { cn } from "@/shared/lib";
import { cva } from "class-variance-authority";
import React from "react";

const cardVariants = cva("rounded-2xl border border-border bg-surface text-foreground", {
  variants: {
    tone: {
      default: "bg-surface",
      raised: "bg-surface-overlay",
      emphasized: "bg-surface-overlay border-primary/30",
      flat: "bg-transparent",
    },
    padding: {
      none: "p-0",
      sm: "p-3",
      md: "p-4",
      lg: "p-6",
    },
  },
  defaultVariants: { tone: "default", padding: "md" },
});

export default function Card({ tone, padding, className, children, ...props }) {
  return (
    <div className={cn(cardVariants({ tone, padding }), className)} {...props}>
      {children}
    </div>
  );
}

export { cardVariants };
