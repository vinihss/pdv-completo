// Tema da marca — a cor principal configurada em Configurações → Identidade.
// O front usa Tailwind 4 (CSS-first): as utilities de cor (ex.: bg-amber-500)
// viram `var(--color-amber-500)` no CSS gerado. Então, pra refletir a cor da
// marca, basta sobrescrever a rampa de variáveis `--color-amber-*` em runtime.
// A página externa (/pedido) usa --brand-accent como cor de destaque.

export const DEFAULT_PRIMARY_COLOR = "#f59e0b"; // amber-500 atual (padrão)

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else if (h < 360) { r = c; b = x; }
  const ch = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === rn) h = 60 * (((gn - bn) / d) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else h = 60 * ((rn - gn) / d + 4);
  if (h < 0) h += 360;
  return { h, s, l };
}

export function shade(hex, delta) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  return hslToHex(h, s, clamp01(l + delta));
}

// Luminância relativa (REC.709) — usada pra decidir texto claro/escuro sobre a cor da marca.
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// aplica a cor na rampa amber + no acento da página externa.
// Também define variantes derivadas:
// - --brand-accent-foreground: branco ou quase-preto, que garante contraste
//   sobre um fundo pintado com a cor da marca (botões, pills, timeline).
// - --brand-accent-strong: tom escurecido, para texto/ícone da cor da marca
//   sobre fundos claros (preço, título, mapin) — cores claras/pálidas sozinhas
//   não têm contraste suficiente sobre um fundo branco.
export function applyBrandPrimary(hex = DEFAULT_PRIMARY_COLOR) {
  const root = document.documentElement;
  const shift = { 100: 0.32, 200: 0.24, 300: 0.16, 400: 0.08, 500: 0, 600: -0.09, 700: -0.18 };
  for (const [k, d] of Object.entries(shift)) {
    root.style.setProperty(`--color-amber-${k}`, shade(hex, d));
  }
  root.style.setProperty("--brand-accent", hex);
  root.style.setProperty("--brand-accent-strong", shade(hex, -0.18));
  root.style.setProperty("--brand-accent-foreground", relativeLuminance(hex) > 0.22 ? "#211b19" : "#ffffff");
}