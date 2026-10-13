import React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/shared/lib";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
  {
    variants: {
      tone: {
        default: "bg-surface-overlay text-foreground",
        primary: "bg-primary/15 text-primary-strong",
        success: "bg-success/15 text-success",
        warning: "bg-warning/15 text-warning",
        danger: "bg-destructive/15 text-destructive",
        muted: "bg-surface text-text-muted",
      },
    },
    defaultVariants: { tone: "default" },
  }
);

export default function Badge({ tone, className, children, ...props }) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props}>{children}</span>;
}

export { badgeVariants };