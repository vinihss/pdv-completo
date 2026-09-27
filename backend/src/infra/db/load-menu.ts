// Carga explícita do cardápio Unami — NÃO roda automaticamente no boot.
// Este script aplica o SQL de dados (seed-data/menu-unami.sql) sob demanda,
// chamado pelo deploy/install.sh após o seed-prod. O SQL é idempotente
// (ON CONFLICT), então rodar de novo não duplica nem sobrescreve campos
// que o gerente tenha alterado no app.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(__dirname, "../../../seed-data/menu-unami.sql");

export async function loadMenu(): Promise<void> {
  if (!fs.existsSync(sqlPath)) {
    console.error(`[load-menu] arquivo não encontrado: ${sqlPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, "utf8");
  // O arquivo é um lote de INSERT com ON CONFLICT — o node-postgres aceita
  // múltiplos statements num único query simples.
  await pool.query(sql);
  console.log("[load-menu] cardápio Unami aplicado (11 categorias, 63 produtos, 3 grupos de cozinha).");
  await pool.end();
}

loadMenu();
