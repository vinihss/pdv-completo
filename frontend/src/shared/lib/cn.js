// Utilitário de classes: `clsx` (condicionais) + `tailwind-merge` (dedup
// de classes conflitantes). Base do design system — use em todo componente
// novo em shared/components e (progressivamente) em widgets/features/pages.
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export default cn;