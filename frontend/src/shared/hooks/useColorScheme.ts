import {
  COLOR_SCHEME_STORAGE_KEY,
  applyColorScheme,
  getSavedColorScheme,
  saveColorScheme,
} from "@/shared/lib/colorScheme.js";
import { useCallback, useEffect, useState } from "react";

export default function useColorScheme() {
  const [colorScheme, setColorScheme] = useState(getSavedColorScheme);

  useEffect(() => {
    const syncFromStorage = (event) => {
      if (event?.key && event.key !== COLOR_SCHEME_STORAGE_KEY) return;
      const next = event?.detail?.colorScheme ?? getSavedColorScheme();
      applyColorScheme(next);
      setColorScheme(next);
    };

    window.addEventListener("storage", syncFromStorage);
    window.addEventListener("pdv:color-scheme-change", syncFromStorage);
    return () => {
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener("pdv:color-scheme-change", syncFromStorage);
    };
  }, []);

  const toggleColorScheme = useCallback(() => {
    const next = colorScheme === "dark" ? "light" : "dark";
    saveColorScheme(next);
    setColorScheme(next);
  }, [colorScheme]);

  return { colorScheme, toggleColorScheme };
}
