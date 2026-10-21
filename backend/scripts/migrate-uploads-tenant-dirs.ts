// Migração do VOLUME de uploads: `<uploadsDir>/<schema>/<kind>/<arquivo>` →
// `<uploadsDir>/<tenantId>/<kind>/<arquivo>`.
//
// One-shot, idempotente, reversível com `--revert`.
//
// POR QUE
// -------
// A Fase 3 (o modelo multi-tenant por LINHA, `docs/28-multitenant-row-level.md`)
// trocou o diretório por loja: ele era o SCHEMA da loja (`tenant_<slug>`, ou
// `public` para o default) e passou a ser o `tenantId` (a identidade estável —
// o slug pode ser renomeado). O `storage-port-adapter.ts` resolve o tenant
// por id (`resolveTenant()`), então um arquivo que ficou no diretório antigo
// simplesmente não é encontrado: a foto some (404 no `/uploads/...`).
//
// ESTE SCRIPT (e o `migrate-uploads-layout.ts`, que é o flat → por loja)
// ------------------------------------------------------------------------
// São dois passos diferentes e precisam ser rodados NESTA ordem:
//
//   1. `migrate-uploads-layout.ts`   — flat → `<schema>/<kind>/` (o layout
//      intermediário do modelo antigo). Já existia; continua válido para quem
//      ainda está no flat.
//   2. `migrate-uploads-tenant-dirs.ts` (este) — `<schema>/` → `<tenantId>/`.
//
// O MAPA schema → tenantId
// ------------------------
// O `public` é o default: o `DEFAULT_TENANT_ID` fixo
// (`00000000-0000-0000-0000-000000000001`). Qualquer outro diretório é o
// schema de uma loja do modelo ANTIGO — e o mapa está no REGISTRY, que a
// migration `0018` limpou (a coluna `schema_name` saiu). Por isso o script
// recusa um diretório que não seja o `public`: o mapa não pode ser adivinhado,
// e chutar o dono de um arquivo é pior do que não mover.
//
// Uso:
//   npm run uploads:migrate-tenant-dirs -- --dry-run    # só o plano
//   npm run uploads:migrate-tenant-dirs                 # move (idempotente)
//   npm run uploads:migrate-tenant-dirs -- --revert     # volta pro layout antigo
//   UPLOADS_DIR=/app/uploads npm run uploads:migrate-tenant-dirs   # em prod
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config/env.js";
import { DEFAULT_TENANT_ID } from "../src/domain/tenant.js";
import { STORAGE_KINDS, type StorageKind } from "../src/infra/storage/storage.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const revert = args.has("--revert");

if (dryRun && revert) {
  console.error("[uploads] --dry-run e --revert são mutuamente exclusivos.");
  process.exit(2);
}

const root = path.resolve(config.uploadsDir);

/** O diretório do default no layout antigo e no novo. */
const SCHEMA_DO_DEFAULT = "public";
const TENANT_DO_DEFAULT = DEFAULT_TENANT_ID;

/**
 * O mapa `diretório → tenantId`.
 *
 * Só o default é automático: o `public` é o schema ÚNICO do modelo por linha
 * e ele é o default. Um diretório `tenant_<slug>` é o schema de uma loja do
 * modelo ANTIGO — e o mapa estava no registry, que a `0018` limpou. Sem o
 * mapa, mover o diretório seria chutar o dono do arquivo.
 */
function tenantIdDoDiretorio(dir: string): string | null {
  if (dir === SCHEMA_DO_DEFAULT) return TENANT_DO_DEFAULT;
  return null;
}

function diretorios(): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function moverArquivo(de: string, para: string): void {
  if (!fs.existsSync(de)) return;
  if (dryRun) return;
  fs.mkdirSync(path.dirname(para), { recursive: true });
  try {
    fs.renameSync(de, para);
  } catch (err) {
    // `rename` falha entre dispositivos (o volume pode ser um bind mount de
    // outro fs) — a cópia + remove é o plano B.
    fs.copyFileSync(de, para);
    fs.rmSync(de);
  }
}

const mode = revert ? "revert" : "move";
console.log(`[uploads] modo=${mode} raiz=${root}`);

let movidos = 0;
let ignorados = 0;
const semMapa: string[] = [];

for (const dir of diretorios()) {
  const tenantId = tenantIdDoDiretorio(dir);
  if (!tenantId) {
    // Um diretório que não é o default: ou é o tenant novo (já migrado), ou é
    // o schema de uma loja do modelo antigo (sem mapa). Os dois casos não se
    // mexem — e o segundo caso é REPORTADO, para a operação decidir.
    if (dir !== TENANT_DO_DEFAULT && !/^[0-9a-f-]{36}$/i.test(dir)) {
      semMapa.push(dir);
      ignorados++;
    }
    continue;
  }
  const destino = revert ? SCHEMA_DO_DEFAULT : tenantId;
  if (dir === destino) continue;

  for (const kind of STORAGE_KINDS) {
    const de = path.join(root, dir, kind);
    if (!fs.existsSync(de)) continue;
    const para = path.join(root, destino, kind);
    for (const arquivo of fs.readdirSync(de)) {
      moverArquivo(path.join(de, arquivo), path.join(para, arquivo));
      movidos++;
    }
    if (!dryRun) {
      try {
        fs.rmdirSync(de);
      } catch {
        // o diretório não ficou vazio (um arquivo que não era do layout) — fica
      }
    }
  }
  if (!dryRun) {
    try {
      fs.rmdirSync(path.join(root, dir));
    } catch {
      // idem
    }
  }
  console.log(`[uploads] ${dir} → ${destino}`);
}

console.log(`[uploads] ${mode}: ${movidos} arquivo(s) movido(s)`);
if (semMapa.length > 0) {
  console.log(
    `[uploads] IGNORADOS (sem mapa schema → tenantId; o mapa estava no registry, que a 0018 limpou): ${semMapa.join(", ")}`,
  );
  console.log(
    "[uploads] mova esses diretórios à mão quando souber o dono (o id de cada loja está em `public.tenant`)",
  );
}
