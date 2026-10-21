// Wrapper de compatibilidade do seed de PRIMEIRO DEPLOY.
//
// DOIS consumidores continuam importing deste arquivo:
//
//   1. `npm run seed:prod` (o script npm) — o runner de baixo nível;
//   2. `provision-tenant.ts` — o BOOTSTRAP do tenant novo, que importa
//      `runProdSeed` daqui. Por isso o `runProdSeed` PRECISA continuar
//      exportado deste caminho: é o contrato com o provisionamento.
//
// A implementação do seed mora agora em `src/infra/db/seeds/prod.ts`, junto
// do catálogo de seeds (`src/infra/db/seeds/manifest.json` — que declara este
// seed com o id `prod` e `productionSafe: true`).
import { closeDatabase } from "./client.js";
import { runProdSeed, type ProdSeedOptions } from "./seeds/prod.js";

export { runProdSeed };
export type { ProdSeedOptions };

// CLI próprio. Precisa do guard: `provision-tenant.ts` importa este arquivo
// para reutilizar o bootstrap, e sem o guard o import dispararia um seed no
// schema default (public) no meio do provisionamento.
if (import.meta.url === `file://${process.argv[1]}`) {
  runProdSeed()
    .then(async () => {
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await closeDatabase();
      process.exit(1);
    });
}
