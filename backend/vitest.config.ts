import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./test/test-db.js";

// Testes do backend rodam contra um Postgres dedicado (pdv_test), com as
// variáveis de ambiente resolvidas ANTES de qualquer import das rotas/use
// cases (o client do Drizzle abre o pool no carregamento do módulo).
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Suítes compartilham o mesmo banco de teste e o `resetState()` limpa
    // estado global (cache da aplicação, tabelas) — roda uma por vez.
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      DEPLOYMENT_MODE: "local",
      JWT_SECRET: "test-secret-com-mais-de-32-caracteres-para-rodar-os-testes",
      LOG_LEVEL: "silent",
    },
  },
});
