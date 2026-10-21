import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./test/test-db.js";

/**
 * Porta do stub do daemon de impressão. Fixa porque `config` (env.ts) é um
 * snapshot no load do módulo — a URL precisa estar resolvida antes de
 * qualquer import, então não dá para usar a porta que o servidor de teste
 * escolheria em runtime.
 */
const PRINTER_STUB_PORT = 3456;

/**
 * O APP fala com o banco pelo PAPEL RESTRITO (`pdv_app`, sem superuser e sem
 * BYPASSRLS) — o mesmo papel do deploy (`docs/28-multitenant-row-level.md`).
 *
 * Não é preciosismo: superuser ignora row security, então uma policy de RLS
 * testada como superuser não prova nada (a suíte de isolamento passaria sem
 * isolar). O papel é criado pelo `globalSetup` (que roda antes dos workers, com
 * o dono) — e o dono é quem pode criar papel e dar grant.
 */
const APP_DB_ROLE = process.env.TEST_APP_DB_ROLE ?? "pdv_app";
const APP_DB_PASSWORD = process.env.TEST_APP_DB_PASSWORD ?? "pdv_app_test_pw";
const APP_DB_URL = (() => {
  const url = new URL(TEST_DATABASE_URL);
  url.username = APP_DB_ROLE;
  url.password = APP_DB_PASSWORD;
  return url.toString();
})();

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
      // O app (e os testes) falam com o papel RESTRITO; o DONO (superuser) fica
      // só para o DDL — as migrations.
      DATABASE_URL: APP_DB_URL,
      MIGRATION_DATABASE_URL: TEST_DATABASE_URL,
      APP_DB_ROLE: APP_DB_ROLE,
      APP_DB_PASSWORD: APP_DB_PASSWORD,
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
