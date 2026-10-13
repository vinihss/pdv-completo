import { Moon, Sun } from "lucide-react";
import useColorScheme from "@/shared/hooks/useColorScheme.js";

export default function ThemeToggle({ className = "" }) {
  const { colorScheme, toggleColorScheme } = useColorScheme();
  const isDark = colorScheme === "dark";
  const label = isDark ? "Ativar tema claro" : "Ativar tema escuro";
  const Icon = isDark ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={toggleColorScheme}
      aria-label={label}
      aria-pressed={isDark}
      title={label}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-overlay hover:text-foreground ${className}`}
    >
      <Icon size={19} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );
}
