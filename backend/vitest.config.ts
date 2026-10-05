import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./test/test-db.js";

/**
 * Porta do stub da Graph API usado por test/whatsapp.test.ts. Fixa porque
 * `config` (env.ts) é um snapshot no load do módulo — a URL precisa estar
 * resolvida antes de qualquer import, então não dá para usar a porta que o
 * servidor de teste escolheria em runtime.
 */
const WHATSAPP_STUB_PORT = 3455;
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
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      DEPLOYMENT_MODE: "local",
      JWT_SECRET: "test-secret-com-mais-de-32-caracteres-para-rodar-os-testes",
      LOG_LEVEL: "silent",

      // ---- Meta / WhatsApp Cloud API ----
      // `config` é snapshot no load do módulo, então a Graph precisa estar
      // apontada aqui, e não no beforeAll da suíte. A suíte whatsapp.test.ts
      // sobe o stub HTTP nesta porta fixa (mesmo truque do IFOOD_MOCK_PORT) e
      // usa THESE valores para conferir a assinatura e o appsecret_proof.
      META_APP_ID: "app-123",
      META_APP_SECRET: "app-secret-de-teste",
      WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "cfg-123",
      WHATSAPP_VERIFY_TOKEN: "verify-me",
      WHATSAPP_GRAPH_BASE_URL: `http://127.0.0.1:${WHATSAPP_STUB_PORT}`,
      WHATSAPP_GRAPH_VERSION: "v99.0",
      // Desligado de propósito: com token de env presente, `resolveConnection()`
      // cairia no caminho legado e os testes da conexão por WABA não provariam nada.
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_PHONE_NUMBER_ID: "",

      // ---- Impressão térmica (daemon local) ----
      // O daemon real é substituído por um stub HTTP local na porta 3456.
      // `config` é snapshot no load do módulo, então a URL precisa estar
      // resolvida antes de qualquer import.
      PRINTER_DAEMON_URL: `http://127.0.0.1:${PRINTER_STUB_PORT}`,

      // ---- Pagar.me V5 ----
      // `config` é snapshot no load do módulo, então a secret key precisa estar
      // aqui para o webhook validar assinatura nos testes. O gateway em si é
      // substituído por um dublê via setPaymentGatewayForTests — nenhuma rede
      // externa é chamada.
      PAGARME_ENABLED: "true",
      PAGARME_SECRET_KEY: "sk_test_pagarme_secret_de_teste",
      PAGARME_BASE_URL: "http://127.0.0.1:3998",
      PAGARME_RECONCILIATION_INTERVAL_MS: "600000",
      // Token do canal interno com o serviço Go `pagarme-webhook/`.
      // `config` é snapshot no load do módulo, então a env precisa estar
      // resolvida aqui; o caso "token NÃO configurado" é coberto por
      // `setInternalTokenForTests(null)`.
      PAGARME_INTERNAL_TOKEN: "tok_interno_de_teste",
    },
  },
});
