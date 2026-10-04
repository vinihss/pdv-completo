// ============================================================
// Migração do layout de uploads: flat → `<uploads>/<schema>/<kind>/<arquivo>`
// (docs/15-multi-tenant-schema.md §4.7). One-shot, idempotente.
//
// O QUE FAZ
//   Lê as 4 colunas que guardam o nome do arquivo (`product.image_path`,
//   `store_settings.logo_path`, `user.photo_path`, `customer.photo_path`),
//   decide o `kind` de cada arquivo e move os que ainda estão no diretório
//   flat. Não mexe no banco (a coluna continua com o basename) e não apaga
//   nada que não reconheceu.
//
// POR QUE PRECISA LER O BANCO
//   Um `<uuid>.png` solto no disco NÃO é classificável por nome — pode ser
//   foto de produto, de cliente ou de usuário. Só a coluna sabe qual. E
//   arquivo órfão (referência que não existe, ou arquivo sem referência) é
//   reportado, nunca apagado: apagar foto de cliente sem saber de quem é
//   exatamente o tipo de perda que não volta.
//
// USO
//   npm run uploads:migrate-layout -- --dry-run     # só o plano, não move
//   npm run uploads:migrate-layout                  # move (idempotente)
//   npm run uploads:migrate-layout -- --copy        # copia e mantém o flat
//   npm run uploads:migrate-layout -- --revert      # volta pro flat
//   UPLOADS_DIR=/app/uploads npm run uploads:migrate-layout   # em prod
//
//   Rodar 2× não faz mal: o que já está no lugar é detectado e pulado.
//
// REVERTER
//   `--revert` move de volta os arquivos que o plano reconhece, na direção
//   oposta. Ele também é idempotente. Se o flat já tiver um arquivo com o
//   mesmo nome (só possível se duas lojas tivessem ids iguais), reporta o
//   conflito e **não** sobrescreve nada.
//
// ANTES EM PRODUÇÃO
//   A janela dedeploy é: instantâneo em que um arquivo está no flat, e a API
//   já devolve `/uploads/<kind>/<arquivo>`. Ela é de SEGUNDOS, afeta só `<img>`
//   (reload resolve) e some no primeiro upload/limpeza. Rodar o script antes
//   do switch deixa a janela menor; rodar depois deixa um HTML já aberto no
//   browser com a URL antiga quebrada. Faça com o volume parado, se possível.
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { isNotNull } from "drizzle-orm";
import { db, pool } from "../src/infra/db/client.js";
import { customers, products, storeSettings, users } from "../src/infra/db/schema.js";
import { config } from "../src/config/env.js";
import { resolveTenantSchema, storageDirFor } from "../src/infra/storage/index.js";
import { isSafeFilename, STORAGE_KINDS, type StorageKind } from "../src/infra/storage/storage.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const copy = args.has("--copy");
const revert = args.has("--revert");

if (copy && revert) {
  console.error("[uploads] --copy e --revert são mutuamente exclusivos.");
  process.exit(2);
}

const root = path.resolve(config.uploadsDir);
const tenant = resolveTenantSchema();

/** Arquivos que uma linha de banco aponta, grouped por kind. */
async function referencedByKind(): Promise<Map<StorageKind, string[]>> {
  const [produtos, logos, equipe, clientes] = await Promise.all([
    db.select({ filename: products.imagePath }).from(products).where(isNotNull(products.imagePath)),
    db.select({ filename: storeSettings.logoPath }).from(storeSettings).where(isNotNull(storeSettings.logoPath)),
    db.select({ filename: users.photoPath }).from(users).where(isNotNull(users.photoPath)),
    db.select({ filename: customers.photoPath }).from(customers).where(isNotNull(customers.photoPath)),
  ]);
  const byKind = new Map<StorageKind, string[]>(STORAGE_KINDS.map((k) => [k, []]));
  for (const row of produtos) byKind.get("product")!.push(row.filename);
  for (const row of logos) byKind.get("logo")!.push(row.filename);
  for (const row of equipe) byKind.get("user")!.push(row.filename);
  for (const row of clientes) byKind.get("customer")!.push(row.filename);
  return byKind;
}

/** Um nome pode ser classificado por mais de um kind? (só `logo.*` é fixo) */
function buildPlan(byKind: Map<StorageKind, string[]>) {
  const owner = new Map<string, StorageKind>();
  const ambiguous: string[] = [];
  for (const kind of STORAGE_KINDS) {
    for (const raw of byKind.get(kind)!) {
      const filename = raw.split(/[\\/]/).pop() ?? "";
      if (!isSafeFilename(filename)) continue; // não é do nosso layout — nem entra no plano
      const seen = owner.get(filename);
      if (seen && seen !== kind) {
        ambiguous.push(`${filename} (${seen} e ${kind})`);
        continue;
      }
      owner.set(filename, kind);
    }
  }
  return { owner, ambiguous };
}

function listFlat(): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

function sameBytes(a: string, b: string): boolean {
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

async function main() {
  if (!fs.existsSync(root)) {
    console.error(`[uploads] diretório não existe: ${root}`);
    process.exit(1);
  }

  const byKind = await referencedByKind();
  const { owner, ambiguous } = buildPlan(byKind);
  if (ambiguous.length > 0) {
    console.error(
      `[uploads] nomes referenciados por mais de um kind (NÃO é possível decidir; revise antes):\n  ${ambiguous.join("\n  ")}`
    );
    process.exit(1);
  }

  // No revert o inventário vem do layout novo (`<schema>/<kind>/`) e o destino
  // é o flat; nos demais, o inverso.
  const moved = new Map<StorageKind, number>(STORAGE_KINDS.map((k) => [k, 0]));
  const alreadyThere: string[] = [];
  const conflicts: string[] = [];
  const orphans: string[] = [];
  const missing: string[] = [];

  const flatFiles = listFlat();

  if (revert) {
    // Percorre o layout novo tenant a tenant, kind a kind.
    for (const kind of STORAGE_KINDS) {
      const dir = storageDirFor(root, tenant, kind);
      if (!fs.existsSync(dir)) continue;
      const presentes = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
      for (const { name: filename } of presentes) {
        const from = path.join(dir, filename);
        const to = path.join(root, filename);
        if (fs.existsSync(to)) {
          (sameBytes(from, to) ? alreadyThere : conflicts).push(filename);
          continue;
        }
        if (!dryRun) fs.renameSync(from, to);
        moved.set(kind, (moved.get(kind) ?? 0) + 1);
      }
    }
    for (const filename of flatFiles) {
      if (!owner.has(filename)) orphans.push(filename);
    }
  } else {
    for (const filename of flatFiles) {
      const kind = owner.get(filename);
      if (!kind) {
        // Órfão: ninguém no banco aponta pra ele. Reporta, não apaga.
        orphans.push(filename);
        continue;
      }
      const from = path.join(root, filename);
      const toDir = storageDirFor(root, tenant, kind);
      const to = path.join(toDir, filename);
      if (fs.existsSync(to)) {
        // Já migrado (ou um upload reescreveu no lugar). Idempotência de graça.
        alreadyThere.push(`${kind}/${filename}`);
        continue;
      }
      if (!dryRun) {
        fs.mkdirSync(toDir, { recursive: true });
        if (copy) fs.copyFileSync(from, to);
        else fs.renameSync(from, to);
      }
      moved.set(kind, (moved.get(kind) ?? 0) + 1);
    }
    // Referência sem arquivo: a coluna aponta pra algo que não está lá (upload
    // de produto nunca gravou, ou volume perdido). Também não é apagável.
    for (const [kind, list] of byKind) {
      for (const raw of list) {
        const filename = raw.split(/[\\/]/).pop() ?? "";
        const candidates = [path.join(root, filename), path.join(storageDirFor(root, tenant, kind), filename)];
        if (!candidates.some((p) => fs.existsSync(p))) missing.push(`${kind}/${filename}`);
      }
    }
  }

  const modo = revert ? "revert" : dryRun ? "dry-run" : copy ? "copy" : "move";
  console.log(`[uploads] modo=${modo} raiz=${root} tenant=${tenant}`);
  for (const kind of STORAGE_KINDS) console.log(`  ${kind}: ${moved.get(kind) ?? 0}`);
  console.log(`  já no lugar: ${alreadyThere.length}`);
  console.log(`  órfãos (mantidos): ${orphans.length}${orphans.length ? ` → ${orphans.join(", ")}` : ""}`);
  console.log(`  referência sem arquivo: ${missing.length}${missing.length ? ` → ${missing.join(", ")}` : ""}`);
  if (conflicts.length > 0) {
    console.error(`  CONFLITOS (nada sobrescrito): ${conflicts.join(", ")}`);
  }
  if (dryRun) console.log("[uploads] dry-run: nada foi movido.");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[uploads] falhou:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
