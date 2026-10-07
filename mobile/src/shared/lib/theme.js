// Tokens de tema do app (RN). O web usa Tailwind 4 (CSS-first); no React
// Native os estilos são StyleSheet, então os tokens da paleta viram
// constantes. É o subconjunto stone/âmbar do CSS do login web
// (`frontend/src/pages/login/LoginPage.jsx`), para a tela nativa chegar perto
// da web. As frentes seguintes usam daqui também.

export const COLORS = {
  // brand (âmbar — o padrão do produto, ver DEFAULT_PRIMARY_COLOR do web)
  brand: "#f59e0b", // amber-500
  brandLight: "#fbbf24", // amber-400
  brandDark: "#d97706", // amber-600

  // fundo/tinta (stone)
  background: "#0c0a09", // stone-950
  surface: "#1c1917", // stone-900
  surfaceRaised: "#292524", // stone-800
  border: "#44403c", // stone-700
  text: "#fafaf9", // stone-50
  textSecondary: "#a8a29e", // stone-400
  textMuted: "#78716c", // stone-500
  textFaint: "#57534e", // stone-600

  danger: "#ef4444", // red-500

  onBrand: "#1c1917", // stone-900 (texto/espaço sobre o botão âmbar)

  // Aliases curtos usados pelas telas de login/provisionamento. A paleta é a
  // mesma; os nomes abaixo são os que o login (portado do web) referencia:
  // sem eles as cores saem `undefined` e a tela fica sem contraste.
  accent: "#fbbf24", // amber-400
  accentForeground: "#1c1917", // stone-900
  surfaceBorder: "#292524", // stone-800
  muted: "#a8a29e", // stone-400
  faint: "#57534e", // stone-600
};

export const SPACING = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
};

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
};

export const FONT = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
};