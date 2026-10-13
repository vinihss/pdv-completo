import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./test/test-db.js";

/**
 * Porta do stub do daemon de impressão. Fixa porque `config` (env.ts) é um
 * snapshot no load do módulo — a URL precisa estar resolvida antes de
 * qualquer import, então não dá para usar a porta que o servidor de teste
 * escolheria em runtime.
 */
const PRINTER_STUB_PORT = 3456;

// Tests do backend rodam contra um Postgres dedicado (pdv_test), com as
// variáveis de ambiente resolvidas ANTES de qualquer import das rotas/use
// cases (o client do Drizzle abre o pool no carregamento do módulo, e o
// `config` do env.ts é um snapshot feito no load).
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Suítes compartilham o mesmo banco de teste, stubs HTTP em portas fixas
    // e o `resetState()` limpa estado global — roda uma por vez.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 30000,
    // O reset (TRUNCATE ... CASCADE) entre casos pode esperar um lock por
    // vários segundos sob carga; o default de 10s gerava flake de "Hook timed
    // out" sem deadlock. Alinhado ao testTimeout.
    hookTimeout: 30000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      DEPLOYMENT_MODE: "local",
      JWT_SECRET: "test-secret-com-mais-de-32-caracteres-para-rodar-os-testes",
      LOG_LEVEL: "silent",

      // ---- Impressão térmica (daemon local) ----
      // O daemon real é substituído por um stub HTTP local na porta 3456.
      // `config` é snapshot no load do módulo, então a URL precisa estar
      // resolvida antes de qualquer import.
      PRINTER_DAEMON_URL: `http://127.0.0.1:${PRINTER_STUB_PORT}`,
    },
  },
});
