import { useEffect } from "react";

export default function ThemeCanvas({ Story, colorScheme }) {
  useEffect(() => {
    const previousTheme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = colorScheme;
    window.dispatchEvent(new CustomEvent("pdv:color-scheme-change", { detail: { colorScheme } }));
    return () => {
      if (previousTheme) document.documentElement.dataset.theme = previousTheme;
      else delete document.documentElement.dataset.theme;
    };
  }, [colorScheme]);

  return (
    <div className="min-h-24 min-w-64 bg-background p-6 text-foreground">
      <Story />
    </div>
  );
}
