export const COLOR_SCHEME_STORAGE_KEY = "pdv:color-scheme";
export const COLOR_SCHEMES = Object.freeze({ light: "light", dark: "dark" });

function normalizeColorScheme(value) {
  return value === COLOR_SCHEMES.dark ? COLOR_SCHEMES.dark : COLOR_SCHEMES.light;
}

export function getSavedColorScheme() {
  try {
    return normalizeColorScheme(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY));
  } catch {
    return COLOR_SCHEMES.light;
  }
}

export function applyColorScheme(value) {
  const colorScheme = normalizeColorScheme(value);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = colorScheme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute("content", colorScheme === COLOR_SCHEMES.dark ? "#2d2925" : "#fffdf8");
  }
  return colorScheme;
}

export function saveColorScheme(value) {
  const colorScheme = applyColorScheme(value);
  try {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, colorScheme);
  } catch {
    // O tema ainda pode ser usado na sessão atual se o armazenamento estiver bloqueado.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pdv:color-scheme-change", { detail: { colorScheme } }));
  }
  return colorScheme;
}

/** Aplica a preferência antes do primeiro paint para evitar flash do tema claro. */
export function initializeColorScheme() {
  return applyColorScheme(getSavedColorScheme());
}
