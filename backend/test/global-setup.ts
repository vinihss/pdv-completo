// Roda uma vez antes de qualquer suíte: derruba e recria o schema `public`
// do Postgres de teste e aplica as migrations pelo runner real — assim cada
// execução parte de um banco limpo E o runner (que é o que o deploy usa) é
// exercitado a cada `npm run test`.
//
// Não importa nada de `src/` no topo: o `process.env.DATABASE_URL` precisa
// estar definido antes do import do client/config (ambos leem no load).
import { Client } from "pg";
import { TEST_DATABASE_URL } from "./test-db.js";

async function recreateSchema() {
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    // DROP CASCADE leva enums, índices e tabelas junto; CREATE devolve o
    // schema vazio no estado inicial que o Postgres cria por padrão.
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
  } finally {
    await admin.end();
  }
}

export default async function globalSetup() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  await recreateSchema();

  const { runMigrations } = await import("../src/infra/db/migrate.js");
  const { closeDatabase } = await import("../src/infra/db/client.js");
  await runMigrations();
  // O pool do processo do vitest não é o das suítes — fecha pra não segurar
  // conexão aberta entre o setup e os testes.
  await closeDatabase();

  return async () => {
    // Teardown best-effort: se o container do Postgres já estiver desligado
    // (CI encerrando), não faz sentido falhar o `npm run test` agora.
    try {
      await recreateSchema();
    } catch (err) {
      console.warn("[test] teardown: não foi possível limpar o banco de teste:", (err as Error).message);
    }
  };
}
