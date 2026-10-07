// Qual dos dois apps é ESTE build.
//
// O mesmo codebase vira "PDV Garçom" ou "PDV Entregador"; o que muda é a
// identidade nativa (name/slug/ids, em app.config.js) e a tela inicial
// (MainScreen escolhe o stub do fluxo por aqui).
//
// `APP_VARIANT` é lida em tempo de BUILD: o babel.config.js inline-a em
// `process.env.APP_VARIANT` (transform-inline-environment-variables), então
// este arquivo é a "constante de build" que o JS enxerga.
//
//   APP_VARIANT=entregador npx expo start      → app do entregador
//   APP_VARIANT=garcon     npx expo start      → app do garçom (default)
//
// No teste (jest), sem a variável no ambiente, o babel inline-a `undefined` e
// o default abaixo vale: garcom.

const RAW = process.env.APP_VARIANT;

export const APP_VARIANTS = ["garcon", "entregador"];

export const APP_VARIANT = RAW === "entregador" ? "entregador" : "garcon";

export function isGarcon() {
  return APP_VARIANT === "garcon";
}

export function isEntregador() {
  return APP_VARIANT === "entregador";
}