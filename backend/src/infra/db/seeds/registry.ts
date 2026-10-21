// Catálogo de seeds — a fonte única de verdade sobre QUAIS seeds existem.
//
// O manifesto (`seeds/manifest.json`) é o MESMO arquivo lido pela CLI Rust
// (`cmd/pdv/src/ops/seeds.rs`) em runtime: incluir um seed novo no catálogo
// NÃO exige recompilar a CLI. Este módulo é a leitura VALIDADA desse
// manifesto para o lado Node — é o que o `apply.ts` (runner genérico) e
// qualquer outro consumidor do backend consultam.
//
// Por que `fs.readFileSync` + `JSON.parse` e não `import manifest from
// "./manifest.json"`: em ESM, importar JSON exige o atributo de tipo
// (`with { type: "json" }`) e o `tsc` NÃO copia o `.json` para o `dist/` — o
// registro leria um arquivo que não existe na imagem de produção. Lendo do
// disco, com o caminho derivado de `import.meta.url`, o mesmo código vale em
// `src` (tsx) e em `dist` (node); o manifesto precisa estar AO LADO do módulo
// e o `postbuild` (`scripts/copy-seed-manifest.mjs`) garante isso.
//
// Manifesto ausente/inválido é ERRO, não seed silencioso: o catálogo é
// contrato com a CLI — se o backend aceitasse um catálogo diferente do que a
// CLI enxerga, `pdv db seed <id>` e `npm run seed:apply <id>` responderiam
// coisas diferentes para o mesmo id.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Um seed do catálogo — espelha 1:1 o item de `manifest.json`.
 *
 * `destructive`/`productionSafe`/`requiresPostgis` são METADADOS: quem decide
 * o que fazer com eles é o consumidor (a CLI já faz o preflight de PostGIS
 * antes de rodar). O backend só valida o formato.
 */
export type SeedDef = {
  /** Identificador curto e estável (`pdv db seed <id>`). */
  id: string;
  /** Nome curto exibido na lista. */
  title: string;
  /** O que o seed faz, em uma linha. */
  description: string;
  /** Script npm do backend que executa o seed (ex.: `seed:demo`). */
  npmScript: string;
  /** Verdadeiro se o seed apaga/sobrescreve dados existentes. */
  destructive: boolean;
  /** Verdadeiro se o seed pode rodar em produção. */
  productionSafe: boolean;
  /** Verdadeiro se o seed usa funções PostGIS (`ST_*`) — exige a extensão. */
  requiresPostgis: boolean;
};

// Espelha `manifest.schema.json` (o JSON Schema que a CLI e o editor
// entendem). O zod é a versão executável: valida em RUNTIME, na hora em que
// o catálogo é lido, e dá mensagem em PT-BR quando o contrato é violado.
const seedDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id aceita apenas minúsculas, números e hífen"),
  title: z.string().min(1, "title não pode ser vazio"),
  description: z.string().min(1, "description não pode ser vazia"),
  npmScript: z.string().min(1, "npmScript não pode ser vazio"),
  destructive: z.boolean(),
  productionSafe: z.boolean(),
  requiresPostgis: z.boolean(),
});

const manifestSchema = z.object({
  version: z.number().int().min(1, "version precisa ser um inteiro >= 1"),
  seeds: z.array(seedDefSchema).min(1, "o catálogo precisa de pelo menos um seed"),
});

/** Caminho absoluto do manifesto — o mesmo arquivo em `src` e em `dist`. */
export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "manifest.json");

let cache: SeedDef[] | null = null;

function readManifest(): SeedDef[] {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `[seeds] manifesto de seeds não encontrado em ${MANIFEST_PATH} — ` +
        "o catálogo é o contrato com a CLI (`pdv db seeds`); sem ele não dá para saber " +
        "quais seeds existem.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    throw new Error(
      `[seeds] manifesto de seeds ilegível (${MANIFEST_PATH}): ${(err as Error).message}`,
    );
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const problemas = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`[seeds] manifesto de seeds inválido (${MANIFEST_PATH}):\n${problemas}`);
  }

  return parsed.data.seeds.map((s) => ({ ...s }));
}

/**
 * Todos os seeds do catálogo, na ordem do manifesto.
 *
 * Lê (e valida) o manifesto uma vez por processo: o catálogo é estático em
 * disco, e reler a cada chamada só abriria espaço para o backend e a CLI
 * discordarem no meio de uma execução.
 */
export function listSeeds(): SeedDef[] {
  if (!cache) cache = readManifest().map((s) => Object.freeze({ ...s }));
  return cache;
}

/** Um seed pelo id — `undefined` se o catálogo não tem esse id. */
export function getSeed(id: string): SeedDef | undefined {
  return listSeeds().find((s) => s.id === id);
}

/** Ids do catálogo, para mensagens de erro ("disponíveis: base, demo, prod"). */
export function listSeedIds(): string[] {
  return listSeeds().map((s) => s.id);
}
