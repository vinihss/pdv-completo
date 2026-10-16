import { cn } from "@/shared/lib";
import { cva } from "class-variance-authority";
import React from "react";

const inputVariants = cva(
  "w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-text-muted focus:border-primary/50 focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      invalid: {
        true: "border-destructive focus:border-destructive focus:ring-destructive/20",
        false: "",
      },
    },
    defaultVariants: { invalid: false },
  }
);

export default function Input({ invalid, className, ...props }) {
  return <input className={cn(inputVariants({ invalid }), className)} {...props} />;
}

export function Textarea({ invalid, className, ...props }) {
  return (
    <textarea
      className={cn(inputVariants({ invalid }), "min-h-[80px] resize-y", className)}
      {...props}
    />
  );
}

export { inputVariants };
