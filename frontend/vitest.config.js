import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config de testes do frontend (roadmap 3.1). Mantém o alias "@" do
// vite.config.js; não herda o plugin tailwind para não carregar o CSS nos
// testes (o JSX dependente de estilos segue renderizando sem classes).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{js,jsx}"],
  },
});