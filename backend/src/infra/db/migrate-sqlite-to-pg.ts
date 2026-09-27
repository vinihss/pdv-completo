// ============================================================
// Migração one-shot SQLite -> Postgres para instalações de produção
// que usavam o deploy antigo (better-sqlite3, data.db no volume
// pdv_backend_data). O app é Postgres-only desde a consolidação das
// 22 migrations em backend/migrations/0001_init.sql.
//
// Uso:
//   npm run db:migrate:sqlite -- --db=/caminho/data.db [--dry-run] [--clean]
//
//   --db     caminho do arquivo SQLite do cliente (obrigatório)
//   --dry-run lê o SQLite e reporta contagens sem escrever no Postgres
//   --clean  TRUNCATE de todas as tabelas do Postgres antes de importar
//            (use só se o Postgres de destino não tiver dados válidos)
//
// O script lê o SQLite em modo read-only e grava no Postgres de
// DATABASE_URL dentro de uma única transação (all-or-nothing). Preserva:
//   * ids (PK text) — inclusive ids não-UUID ('system', 'singleton',
//     telefone, cat-unami-*, p-unami-NNN);
//   * hashes de PIN (argon2) — copiados como estão;
//   * timestamps — normalizados para o formato ISO-8601 do Postgres
//     (toISOString: ms + "Z"), porque o app ordena lexicográfico o TEXT;
//   * ordem de inserção do ledger — purchase_item.seq / stock_movement.seq
//     / outbox_event.seq recebem o rowid do SQLite (a média móvel de custo
//     é um replay dessa ordem; o rowid era a desambiguação no SQLite).
//
// Conversões de tipo (detectadas no information_schema do Postgres):
//   * boolean: INTEGER 0/1 do SQLite -> true/false;
//   * enum: os valores TEXT já são os mesmos do enum do Postgres
//     (order.status, user.role, cash_drawer.status, etc.);
//   * JSON-in-TEXT (variations, selected_variations, ifood_payments,
//     delivery_fee_tiers, enabled_payment_methods, cart_items, items, raw)
//     já é TEXT nos dois lados — copiado como está.
// ============================================================
import Database from "better-sqlite3";
import { pool } from "./client.js";

interface MigrateArgs {
  dbPath: string;
  dryRun: boolean;
  clean: boolean;
}

function parseArgs(argv: string[]): MigrateArgs {
  const args: MigrateArgs = { dbPath: "", dryRun: false, clean: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--clean") args.clean = true;
    else if (arg.startsWith("--db=")) args.dbPath = arg.slice(5);
    else if (arg === "--db") args.dbPath = argv[++i] ?? "";
  }
  if (!args.dbPath) {
    console.error("Uso: npm run db:migrate:sqlite -- --db=/caminho/data.db [--dry-run] [--clean]");
    process.exit(1);
  }
  return args;
}

// Tabelas na ordem que respeita as FKs (pais antes dos filhos).
const TABLES_IN_FK_ORDER = [
  "user",
  "category",
  "kitchen_group",
  "product",
  "restaurant_table",
  "customer",
  "order",
  "order_item",
  "order_payment",
  "supplier",
  "purchase",
  "purchase_item",
  "stock_movement",
  "cash_drawer",
  "cash_drawer_movement",
  "store_settings",
  "audit_log",
  "idempotency_key",
  "outbox_event",
  "customer_address",
  "customer_cart",
  "geocoding_cache",
  "delivery",
  "whatsapp_conversation",
  // iFood: não existiam nas migrations SQLite — só aparecem se o
  // cliente tiver usado a integração (tabelas criadas pelo código).
  "ifood_event",
  "ifood_state",
];

// Tabelas cuja ordem de inserção é carregada (seq BIGSERIAL no PG =
// rowid do SQLite). A média móvel de custo é um replay do ledger, então
// a ordem precisa ser estável e fiel à original.
const SEQ_TABLES = new Set(["purchase_item", "stock_movement", "outbox_event"]);

type Row = Record<string, unknown> & { __rowid?: number };

// Converte timestamps do SQLite para o formato ISO-8601 que o Postgres
// usa (Date.prototype.toISOString(): 3 casas de ms + "Z"). O DEFAULT do
// SQLite era current_timestamp = "YYYY-MM-DD HH:MM:MM" UTC; o app ordena
// lexicográfico o TEXT, então o formato precisa ser uniforme.
function normalizeTs(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  // "YYYY-MM-DD HH:MM:SS" (current_timestamp do SQLite) — UTC por definição.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value.replace(" ", "T")}.000Z`;
  }
  // ISO sem milissegundos: "YYYY-MM-DDTHH:MM:SSZ".
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value}.000Z`;
  }
  return value;
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "true" || value === "1";
  return Boolean(value);
}

function looksLikeTimestamp(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value);
}

interface TableReport {
  table: string;
  sqliteCount: number;
  inserted: number;
  pgCount: number;
  skipped?: string;
}

async function migrateTable(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  sqlite: Database.Database,
  table: string,
): Promise<TableReport> {
  const report: TableReport = { table, sqliteCount: 0, inserted: 0, pgCount: 0 };

  const exists = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  if (!exists) {
    report.skipped = "não existe no SQLite (cliente não usa este recurso)";
    return report;
  }

  const sqliteCols = (sqlite
    .prepare(`PRAGMA table_info("${table}")`)
    .all() as Array<{ name: string }>).map((c) => c.name);
  const sqliteColSet = new Set(sqliteCols);

  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  const pgTypes = new Map<string, string>(
    (rows as Array<{ column_name: string; data_type: string }>).map((r) => [r.column_name, r.data_type]),
  );

  const commonCols = sqliteCols.filter((c) => pgTypes.has(c));
  if (commonCols.length === 0) {
    report.skipped = "sem colunas comuns com o Postgres";
    return report;
  }

  const hasSeq = SEQ_TABLES.has(table);
  const selectSql = hasSeq
    ? `SELECT rowid AS __rowid, * FROM "${table}" ORDER BY rowid`
    : `SELECT * FROM "${table}"`;
  const allRows = sqlite.prepare(selectSql).all() as Row[];
  report.sqliteCount = allRows.length;
  // O usuário técnico 'system' é inserido pelo próprio 0001_init.sql
  // (ON CONFLICT DO NOTHING) — migrá-lo de novo geraria conflito de PK.
  // A contagem acima o inclui; no PG ele também existe (via schema), então
  // a verificação final continua válida.
  const rowsToInsert = table === "user" ? allRows.filter((r) => r.id !== "system") : allRows;

  if (allRows.length === 0) return report;

  // Checagem: o PG garante UMA sessão de caixa aberta (unique index
  // parcial). O SQLite também tinha esse índice, mas validamos por segurança.
  if (table === "cash_drawer") {
    const open = allRows.filter((r) => r.status === "open");
    if (open.length > 1) {
      const sorted = [...open].sort((a, b) =>
        String(a.opened_at ?? "").localeCompare(String(b.opened_at ?? "")),
      );
      const keep = sorted[sorted.length - 1];
      for (const drawer of sorted.slice(0, -1)) {
        drawer.status = "closed";
        drawer.closed_at = keep.opened_at;
        drawer.closed_by = drawer.opened_by;
        drawer.closing_note =
          "Fechado automaticamente na migração SQLite→Postgres (múltiplas sessões abertas)";
      }
      console.log(
        `  [warn] cash_drawer: ${open.length} sessões abertas no SQLite; ${open.length - 1} fechada(s) automaticamente`,
      );
    }
  }

  // Checagem: o CHECK de identificação da comanda (mesa/cliente/rótulo)
  // já existia no SQLite, mas validamos para falhar com mensagem clara.
  if (table === "order") {
    const invalid = allRows.filter((r) => !r.table_id && !r.customer_id && !r.tab_label);
    if (invalid.length > 0) {
      throw new Error(
        `order: ${invalid.length} comanda(s) sem mesa/cliente/rótulo — ` +
          `corrija no SQLite antes de migrar (CHECK chk_order_identification_required)`,
      );
    }
  }

  const cols = hasSeq ? ["seq", ...commonCols] : commonCols;
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const insertSql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;

  for (const row of rowsToInsert) {
    const values = cols.map((c) => {
      if (c === "seq") return row.__rowid;
      const v = row[c];
      if (pgTypes.get(c) === "boolean") return toBool(v);
      if (looksLikeTimestamp(v)) return normalizeTs(v);
      return v ?? null;
    });
    await client.query(insertSql, values);
  }
  report.inserted = rowsToInsert.length;

  return report;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[migrate] SQLite: ${args.dbPath}`);
  console.log(`[migrate] Postgres: ${process.env.DATABASE_URL?.replace(/:[^:@/]*@/, ":***@") ?? "(DATABASE_URL ausente)"}`);
  console.log(`[migrate] modo: ${args.dryRun ? "dry-run (não escreve)" : args.clean ? "importação com --clean" : "importação"}`);
  console.log("");

  const sqlite = new Database(args.dbPath, { readonly: true, fileMustExist: true });

  const client = await pool.connect();
  const report: TableReport[] = [];
  try {
    if (!args.dryRun) {
      await client.query("BEGIN");
      if (args.clean) {
        await client.query(
          `TRUNCATE ${TABLES_IN_FK_ORDER.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
        );
        console.log("[migrate] --clean: tabelas do Postgres truncadas");
      }
      // Garante o usuário técnico 'system' (alvo de FK de pedidos
      // self-service). O 0001_init.sql o insere, mas o --clean o remove —
      // sem ele, qualquer pedido self-service migrado quebra a FK.
      await client.query(
        `INSERT INTO "user" (id, name, role, pin_hash, active)
         VALUES ('system', 'Pedidos automáticos (self-service)', 'system', 'SYSTEM_ACCOUNT_NO_LOGIN', false)
         ON CONFLICT (id) DO NOTHING`,
      );
    }

    for (const table of TABLES_IN_FK_ORDER) {
      const r = await migrateTable(client, sqlite, table);
      if (r.skipped) {
        console.log(`  [skip] ${r.table}: ${r.skipped}`);
      } else if (r.inserted === 0) {
        console.log(`  [ok] ${r.table}: 0 linhas`);
      } else {
        console.log(`  [ok] ${r.table}: ${r.inserted} linha(s)`);
      }
      report.push(r);
    }

    if (!args.dryRun) {
      // Reancora as sequências dos BIGSERIAL ao maior rowid migrado — sem
      // isso, o próximo insert geraria seq colidindo com as linhas migradas.
      for (const t of SEQ_TABLES) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${t}', 'seq'),
             COALESCE((SELECT MAX(seq) FROM "${t}"), 1), true)`,
        );
      }
      await client.query("COMMIT");
    }

    // Tabelas do SQLite fora da lista (não deve existir nenhuma — se
    // existir, o cliente usa recurso que este script não conhece).
    const allSqliteTables = (
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    const unknown = allSqliteTables.filter((n) => !TABLES_IN_FK_ORDER.includes(n));
    if (unknown.length > 0) {
      console.log(`\n[warn] tabelas não migradas (fora do escopo): ${unknown.join(", ")}`);
    }

    // Verificação final: contagem no Postgres (fora da transação, já
    // COMMITada) comparada com o SQLite.
    console.log("\n[migrate] verificação final:");
    let mismatch = false;
    for (const r of report) {
      if (r.skipped || r.sqliteCount === 0) continue;
      const { rows } = await client.query<{ count: string }>(`SELECT count(*) AS count FROM "${r.table}"`);
      r.pgCount = Number(rows[0].count);
      const ok = r.pgCount === r.sqliteCount;
      if (!ok) mismatch = true;
      console.log(`  ${ok ? "ok  " : "ERRO"} ${r.table}: sqlite=${r.sqliteCount} pg=${r.pgCount}`);
    }

    if (args.dryRun) {
      console.log("\n[migrate] dry-run concluído — nada foi escrito.");
    } else if (mismatch) {
      console.error("\n[migrate] ERRO: divergência de contagem após COMMIT.");
      process.exitCode = 1;
    } else {
      console.log("\n[migrate] concluído com sucesso.");
    }
  } catch (err) {
    if (!args.dryRun) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error(`\n[migrate] FALHOU: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

// Permite rodar via `npm run db:migrate:sqlite` diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
