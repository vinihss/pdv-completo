import { Input } from "@/shared/components";
import { cn } from "@/shared/lib";
import { Eye, EyeOff } from "lucide-react";
import React, { useState } from "react";

/**
 * Input de senha com o "olho" mostrar/ocultar. Autocomplete e placeholder
 * ficam por conta de quem usa (current-password no login, new-password nas
 * telas de troca/reset).
 */
export default function PasswordInput({ className, ...props }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={cn("pr-11", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-text-muted hover:text-foreground transition-colors"
      >
        {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}
