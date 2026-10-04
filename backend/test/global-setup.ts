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

// Rótulo legível do banco (host/porta/banco, sem a senha) para a mensagem de erro.
function describeDatabase(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.host}/${url.pathname.replace(/^\//, "")}`;
  } catch {
    return connectionString.replace(/:[^:@/]*@/, ":***@");
  }
}

/**
 * Devolve a mensagem de erro se houver outro processo conectado no banco de
 * teste, ou `null` se o banco é só nosso. Quem chama decide como abortar.
 *
 * Sem esta checagem, o sintoma é o pior possível para diagnosticar: a suíte
 * NÃO falha com "banco ocupado", ela falha com asserções erradas em
 * `test/outbox-dispatcher.test.ts`, e *quais* testes falham muda de execução
 * para execução. A causa é o `startOutboxDispatcher()`
 * (src/http/server.ts:197), que roda a cada 200ms em qualquer servidor de pé:
 * um servidor de dev apontado para `pdv_test` publica as linhas mais antigas
 * do outbox por `created_at` antes de o teste chamar `pollOutboxOnce()` (daí
 * "teto de 50" virar 25) e disputa o advisory lock do `tryWithAdvisoryLock`
 * (daí `pollOutboxOnce()` devolver 0 quando deveria devolver 1).
 *
 * Nenhum dos dois é bug de código — o código de produção está certo; o que
 * está errado é a configuração de ambiente. Como o sintoma é idêntico ao de
 * um bug real, o guard existe para trocar "flaky em 2 testes que ninguém
 * entende" por "a causa está nomeada".
 *
 * Bônus: com conexão estrangeira viva, o `DROP SCHEMA public CASCADE` do
 * próprio `recreateSchema` também pode travar ou falhar de forma confusa — o
 * guard falha antes, com mensagem legível e sem tocar no schema.
 *
 * `TEST_ALLOW_FOREIGN_CONNECTIONS=1` é o escape para quem legitimamente
 * precisa: depurar o banco na mão enquanto a suíte roda, ou duas execuções
 * concorrentes (ex.: dois worktrees partilhando o mesmo Postgres de teste).
 * Com o escape, aceita-se a instabilidade em troca de não ser impedido.
 */
async function describeForeignConnections(
  connectionString: string,
): Promise<string | null> {
  if (process.env.TEST_ALLOW_FOREIGN_CONNECTIONS === "1") return null;

  const probe = new Client({ connectionString });
  await probe.connect();
  try {
    // `backend_type = 'client backend'` é obrigatório: sem ele a consulta
    // acusaria autovacuum, walwriter, checkpointer e afins, que sempre estão
    // no `pg_stat_activity` e não têm nada a ver com a suíte. E `pid <>
    // pg_backend_pid()` exclui esta própria conexão de sonda.
    const { rows } = await probe.query<{
      pid: number;
      application_name: string | null;
      state: string | null;
      client_addr: string | null;
    }>(
      `SELECT pid, application_name, state, client_addr
         FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND backend_type = 'client backend'
        ORDER BY pid`,
    );
    if (rows.length === 0) return null;

    const found = rows.map(
      (r) =>
        `  - pid ${r.pid}  application_name=${r.application_name || "(vazio)"}  ` +
        `state=${r.state ?? "?"}  client_addr=${r.client_addr ?? "(local)"}`,
    );

    return [
      `[test] o banco de teste (${describeDatabase(connectionString)}) está sendo usado por outro processo — abortando antes de estragar a suíte.`,
      "",
      `Conexões de cliente encontradas além desta (${rows.length}):`,
      ...found,
      "",
      "O que fazer:",
      '  1. Ache e pare o processo: `ss -tnp | grep 55432` e',
      '     `ps -eo pid,ppid,etimes,args | grep "dist/http/server.js"`.',
      "     Servidor órfão de `npm run dev` é o caso comum (PPID 1 denuncia ele).",
      "  2. Se o processo legítimo precisa ficar no ar, aponte o `DATABASE_URL`",
      "     dele para OUTRO banco (o de dev) e suba de novo.",
      "",
      "Por que isso quebra a suíte (e por que a mensagem importa):",
      "  `startOutboxDispatcher()` roda a cada 200ms em qualquer servidor de pé",
      "  (src/http/server.ts:197). Com um servidor alheio no mesmo banco ele",
      "  publica as linhas mais antigas do outbox e disputa o advisory lock com",
      "  a suíte, e `test/outbox-dispatcher.test.ts` falha com contagens erradas",
      '  (`expected 25 to be 50`, ou `pollOutboxOnce()` devolvendo 0) — e os',
      "  testes que caem mudam de execução para execução. Nenhum dos dois é bug",
      "  de código; é configuração de ambiente.",
      "",
      "Escape: TEST_ALLOW_FOREIGN_CONNECTIONS=1 desliga esta checagem.",
    ].join("\n");
  } finally {
    await probe.end();
  }
}

export default async function globalSetup() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  // `console.error` + `exit(1)`, e não `throw`: o `throw` no global setup sai
  // pelo caminho de "Unhandled Error" do vitest, que ainda imprime um
  // "No test files found" confuso logo acima e joga a pessoa para longe da
  // causa real. Mensagem na stderr + exit 1 sai limpa. A sonda é fechada
  // dentro de `describeForeignConnections` (no `finally`), então abortar aqui
  // não deixa conexão pendurada.
  const problema = await describeForeignConnections(TEST_DATABASE_URL);
  if (problema) {
    console.error(problema);
    process.exit(1);
  }

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