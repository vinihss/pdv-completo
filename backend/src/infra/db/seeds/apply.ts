// Runner genérico de seed — `tsx src/infra/db/seeds/apply.ts <id>`.
//
// É a ponte entre o CATÁLOGO (`seeds/manifest.json` — o mesmo arquivo lido
// pela CLI Rust em runtime) e o CÓDIGO de cada seed: o manifesto diz o que
// existe, este arquivo diz como cada id roda.
//
// Por que existir, já que cada seed tem o seu `npm run seed:<id>`: o catálogo
// passou a ser o índice, e o caminho canônico virou "pegue o id do catálogo e
// rode". O `apply` é o que permite `pdv db seed <id>` e o uso direto
// (`npx tsx src/infra/db/seeds/apply.ts demo`) sem duplicar a lista de ids em
// código — e sem que o backend e a CLI discordem sobre o que existe.
//
// Id desconhecido sai com != 0 e a lista dos ids válidos (mesma política do
// `pdv db seed <id>` da CLI): erro de digitação não pode virar "seed rodado
// em silêncio".
import { closeDatabase } from "../client.js";
import { getSeed, listSeedIds, listSeeds } from "./registry.js";
import { runBaseSeed } from "./base.js";
import { runDemoSeed } from "./demo.js";
import { runProdSeed } from "./prod.js";

/**
 * Runner de cada id do catálogo.
 *
 * Chaveado pelo id e NÃO pelo `npmScript` do manifesto: o manifesto é dado
 * (a CLI o lê em runtime), o código do runner não pode ser gerado em runtime.
 * Um id do manifesto sem runner aqui é erro explícito, não seed pulado.
 */
const RUNNERS: Record<string, () => Promise<void>> = {
  base: () => runBaseSeed(),
  demo: () => runDemoSeed(),
  prod: () => runProdSeed(),
};

/** Texto de uso (lista o catálogo). Não pode estourar se o manifesto estiver ruim. */
function usage(): string {
  let linhas: string[];
  try {
    linhas = listSeeds().map((s) => `  ${s.id.padEnd(8)} ${s.title}`);
  } catch (err) {
    linhas = [`  (catálogo indisponível: ${(err as Error).message})`];
  }
  return ["uso: tsx src/infra/db/seeds/apply.ts <id>", "", "seeds disponíveis:", ...linhas].join("\n");
}

/**
 * Aplica o seed do catálogo com o id informado.
 *
 * Erros de id desconhecido / seed sem runner são `Error` com mensagem em
 * PT-BR — o chamador (CLI) decide o código de saída.
 */
export async function applySeed(id: string): Promise<void> {
  const seed = getSeed(id);
  if (!seed) {
    throw new Error(`seed desconhecido: "${id}"\ndisponíveis: ${listSeedIds().join(", ")}`);
  }

  const runner = RUNNERS[seed.id];
  if (!runner) {
    throw new Error(
      `seed "${seed.id}" está no catálogo (${seed.npmScript}) mas não tem runner implementado no backend.`,
    );
  }

  console.log(`[seeds] aplicando "${seed.id}" — ${seed.title}`);
  console.log(`[seeds] ${seed.description}`);
  await runner();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = (process.argv[2] ?? "").trim();
  if (!id) {
    console.error(usage());
    process.exit(1);
  }
  applySeed(id)
    .then(async () => {
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await closeDatabase();
      process.exit(1);
    });
}
