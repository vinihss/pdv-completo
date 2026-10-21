// Garante o PAPEL do app: um role **sem superuser e sem BYPASSRLS**.
//
// POR QUE ESTE PASSO É PRÉ-REQUISITO (e não a última etapa)
// ---------------------------------------------------------
// O modelo multi-tenant por linha (`docs/28-multitenant-row-level.md`) só tem
// barreira de verdade com RLS — e RLS é INERTE enquanto o app conecta como
// superuser: superuser sempre burla row security, inclusive com `FORCE ROW
// LEVEL SECURITY`. Isso foi medido em produção (`pdv | rolsuper=t`): policy
// sem papel restrito é a mesma fachada de isolamento que a primeira iteração
// row-level do projeto pagou (vazamento entre lojas).
//
// Então a troca de papel vem ANTES das policies — e vem com o schema-por-tenant
// ainda no ar, para que o rollback seja uma troca de env.
//
// O QUE ESTE SCRIPT FAZ (idempotente)
// -----------------------------------
//  1. Cria o papel se não existir, com `NOSUPERUSER NOCREATEDB NOCREATEROLE
//     NOINHERIT NOBYPASSRLS` — e REAPLICA esses atributos se o papel já
//     existia (um papel criado às pressas pode ter vindo superuser).
//  2. Define a senha (`APP_DB_PASSWORD`).
//  3. Dá os grants: CONNECT no banco, USAGE no schema e DML nas tabelas — do
//     `public` (registry + dado do tenant default) e de cada schema
//     `tenant_*` que existir.
//
// OPT-IN E REVERSÍVEL
// -------------------
// Sem `APP_DB_PASSWORD` no ambiente, este script **não faz nada** e avisa: o
// app continua usando o papel que a `DATABASE_URL` apontar (hoje: o dono).
// A troca é, portanto, uma decisão de env — e desfeita trocando a env de
// volta.
//
// Uso (no boot do backend e no deploy):
//   APP_DB_PASSWORD=... node dist/infra/db/ensure-app-role.js
import { config } from "../../config/env.js";
import { withMigrationPool } from "./migration-db.js";

/** Nome de papel aceito (vai para o SQL — precisa ser identificador seguro). */
const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export type EnsureAppRoleResult = {
  role: string;
  /** `true` quando o papel acabou de ser criado. */
  created: boolean;
  /** Schemas que receberam grant. */
  schemas: string[];
};

export async function ensureAppRole(): Promise<EnsureAppRoleResult | null> {
  const role = config.appDbRole;
  const password = config.appDbPassword;

  if (!password) {
    console.warn(
      "[app-role] APP_DB_PASSWORD não definido — o app segue com o papel atual (sem troca de role). " +
        "Para ativar o papel restrito (pré-requisito do RLS), defina APP_DB_PASSWORD e aponte " +
        "a DATABASE_URL para ele.",
    );
    return null;
  }

  if (!ROLE_NAME_PATTERN.test(role)) {
    throw new Error(`[app-role] nome de papel inválido: ${JSON.stringify(role)}`);
  }

  return await withMigrationPool("public", async (pool) => {
    const { rows } = await pool.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = $1",
      [role],
    );
    const created = rows.length === 0;

    if (created) {
      await pool.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      console.log(`[app-role] papel "${role}" criado (sem superuser, sem BYPASSRLS)`);
    } else {
      // Um papel que já existia pode ter vindo com atributos perigosos
      // (superuser, BYPASSRLS): reaplicar é o que garante a barreira.
      await pool.query(
        `ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      console.log(`[app-role] papel "${role}" já existia — atributos restritos reaplicados`);
    }

    // A senha não aceita bind parameter (`ALTER ROLE ... PASSWORD` é
    // statement de utility): o `format()` com %I/%L é o jeito seguro de
    // interpolar sem montar SQL na mão.
    const passwordSql = await pool.query<{ password_sql: string }>(
      // Os casts são obrigatórios: `format()` é variádico e o Postgres não
      // consegue inferir o tipo de um $1 solto.
      "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS password_sql",
      [role, password],
    );
    await pool.query(passwordSql.rows[0].password_sql);

    const { rows: dbRows } = await pool.query<{ datname: string }>(
      "SELECT current_database() AS datname",
    );
    const database = dbRows[0].datname;
    await pool.query(`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(role)}`);

    // O `public` (registry + dado do tenant default) e cada schema de tenant.
    const { rows: schemaRows } = await pool.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname = 'public' OR nspname LIKE 'tenant\\_%' ORDER BY nspname",
    );

    for (const { nspname } of schemaRows) {
      const s = quoteIdent(nspname);
      const r = quoteIdent(role);
      await pool.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
      await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${r}`);
      await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${r}`);
    }

    // Tabelas futuras: quem cria (o dono, via as migrations) precisa que o
    // papel do app já esteja nos default privileges — senão uma tabela nova
    // nasce sem grant e o app quebra em runtime.
    const r = quoteIdent(role);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${r}`);

    console.log(
      `[app-role] grants aplicados em ${schemaRows.length} schema(s): ${schemaRows.map((s) => s.nspname).join(", ")}`,
    );

    return { role, created, schemas: schemaRows.map((s) => s.nspname) };
  });
}

/** Identificador entre aspas duplas (o nome já foi validado pelo chamador). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// CLI próprio.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureAppRole()
    .then((res) => {
      if (!res) {
        console.log("[app-role] nada a fazer (sem APP_DB_PASSWORD)");
        process.exit(0);
      }
      console.log(`[app-role] papel "${res.role}" pronto (${res.created ? "criado" : "já existia"})`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[app-role] ERRO:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
