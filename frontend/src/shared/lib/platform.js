// Detecta o runtime. O app é o mesmo código servindo três alvos:
//
//   navegador (PWA/servido pelo Caddy) → web
//   webview do Tauri (Windows/Linux/Mac) → desktop
//
// A origem do desktop é `tauri.localhost` (Windows) / `tauri://localhost`
// (Linux/Mac). Detectar por `__TAURI_INTERNALS__` funciona nos dois e não
// depende do valor exato da origem — que muda entre plataformas e versões.

export function isDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isWeb() {
  return !isDesktop();
}
