import { defineConfig } from "vitest/config";

// Testes do backend rodam contra um SQLite dedicado (data/test.db), com
// variáveis de ambiente resolvidas ANTES de qualquer import das rotas/use
// cases (o client do Drizzle abre o banco no carregamento do módulo).
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Suítes compartilham o mesmo SQLite dedicado (data/test.db) — roda uma
    // por vez para não corromper estado entre arquivos.
    fileParallelism: false,
    env: {
      DATABASE_URL: "sqlite:./data/test.db",
      DEPLOYMENT_MODE: "local",
      JWT_SECRET: "test-secret-com-mais-de-32-caracteres-para-rodar-os-testes",
      LOG_LEVEL: "silent",
    },
  },
});