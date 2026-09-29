// Roda uma vez antes de qualquer suíte: derruba e recria o schema `public`
// do Postgres de teste e aplica as migrations pelo runner real — assim cada
// execução parte de um banco limpo E o runner (que é o que o deploy usa) é
// exercitado a cada `npm run test`.
//
// Não importa nada de `src/` no topo: o `process.env.DATABASE_URL` precisa
// estar definido antes do import do client/config (ambos leem no load).
import { Client } from "pg";
import { TEST_DATABASE_URL } from "./test-db.js";

async function recreateSchema(connectionString: string) {
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
  } finally {
    await admin.end();
  }
}

export default async function globalSetup() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  await recreateSchema(TEST_DATABASE_URL);

  const { runMigrations } = await import("../src/infra/db/migrate.js");
  const { closeDatabase } = await import("../src/infra/db/client.js");
  await runMigrations();
  await closeDatabase();

  return async () => {
    try {
      await recreateSchema(TEST_DATABASE_URL);
    } catch (err) {
      console.warn("[test] teardown: não foi possível limpar o banco de teste:", (err as Error).message);
    }
  };
}