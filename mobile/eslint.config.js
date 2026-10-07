// ESLint 9 (flat config). Mesma forma que `npx expo lint` gera: defineConfig
// (eslint/config) + os 13 configs do eslint-config-expo/flat.
const { defineConfig } = require("eslint/config");
const globals = require("globals");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/", ".expo/", "node_modules/"],
  },
  {
    files: ["**/*.test.js", "**/*.test.jsx"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
  // Rebaixadas a warning: o eslint-plugin-react-hooks v7 (via eslint-config-expo)
  // caiu em 3 regras que marcam padrões INTENCIONAIS deste app (portados 1:1 do
  // web e presos por teste): boot server-authoritative (setState síncrono no
  // efeito de montagem — comitado e recarregado via REST) e refs de socket/no
  // foco usadas dentro de closure de efeito/evento, não durante render.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  // O app é JS (jsconfig, não tsconfig): o resolver `typescript` do
  // eslint-config-expo precisa do project apontando pro jsconfig pra achar o
  // alias `@/*` → `src/*` que o Metro/jest usam.
  {
    settings: {
      "import/resolver": {
        node: {
          extensions: [".js", ".jsx"],
        },
        typescript: {
          project: "./jsconfig.json",
        },
      },
    },
  },
]);