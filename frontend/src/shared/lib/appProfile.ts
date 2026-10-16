// Qual dos 4 apps está aberto. O MESMO código React serve os 4 (frente de
// caixa, cozinha, garçom e entregador) — o que muda é a entry HTML em que ele
// subiu, e cada entry declara o seu profile antes do bundle carregar.
//
// Por que não deduzir de `location.pathname`: o mesmo app aparece em
// `/kds/` no web e em `tauri://localhost/` no desktop, e no build `all` as 4
// entries ficam lado a lado na mesma origem. A URL não identifica o app; a
// entry que o abriu, sim.
//
// Ordem de resolução:
//   1. `window.__APP_PROFILE__` — injetado pelo `<script data-app-profile>`
//      de cada entry. O `vite/app-profiles.js` troca o valor pelo profile real
//      do build, então ele distingue as 4 entries mesmo no bundle único.
//   2. `__APP_PROFILE__` — valor do build (`define` no vite.config.js), que
//      vale para o bundle inteiro, inclusive se o app abrir sem passar por uma
//      entry.
//   3. `all` — o app único, como sempre foi.

/* global __APP_PROFILE__ */
const BUILD_PROFILE = typeof __APP_PROFILE__ === "string" ? __APP_PROFILE__ : "all";

/** Os profiles de `VITE_APP_PROFILE` (o `all` inclusive). */
export const APP_PROFILES = ["all", "pdv", "kds"];

/** O profile do app aberto, resolvido na ordem acima. */
export function appProfile() {
  if (typeof window !== "undefined" && typeof window.__APP_PROFILE__ === "string") {
    return window.__APP_PROFILE__;
  }
  return BUILD_PROFILE;
}

/**
 * Este bundle é um app só (build `VITE_APP_PROFILE=<profile>`) ou o app
 * único com as 4 telas? No `all` o app serve tudo, como sempre; nos demais
 * é a janela de um app específico.
 */
export function isSingleAppBuild() {
  return BUILD_PROFILE !== "all";
}
