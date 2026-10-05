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
    // `vite/` entra porque é onde mora a config de build por profile (as 4
    // entries), que o `npm run build` só exercita de raspão — o teste é o
    // lugar de provar que o app padrão continua byte a byte igual.
    include: ["src/**/*.test.{js,jsx}", "vite/**/*.test.js"],
    // Um jsdom por arquivo consumia ~12s e 7+ instâncias, e a suíte chegou a
    // reportar arquivos inteiros falhando sob pressão de memória da máquina
    // (2,5GB livres de 19,8GB, com ~7GB em chromium de outras apps), sem
    // falha determinística. vmThreads cria o ambiente uma vez por worker.
    pool: "vmThreads",
  },
});