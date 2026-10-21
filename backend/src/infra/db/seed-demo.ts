// Wrapper de compatibilidade do seed de DEMONSTRAÇÃO.
//
// `npm run seed:demo` continua apontando para este arquivo; a implementação
// do seed mora agora em `src/infra/db/seeds/demo.ts`, junto do catálogo de
// seeds (`src/infra/db/seeds/manifest.json` — que declara este seed com o id
// `demo` e `requiresPostgis: true`).
//
// O seed demo é o que cria dados FICTÍCIOS para o ambiente de demonstração:
// catálogo, clientes e 30 dias de histórico. Nunca em produção.
import { closeDatabase } from "./client.js";
import { runDemoSeed } from "./seeds/demo.js";

export { runDemoSeed };

// CLI próprio. O guard é obrigatório: o runner genérico (`seeds/apply.ts`)
// importa o módulo novo direto, mas nada impede um import futuro deste
// wrapper — sem o guard, o import dispararia o seed inteiro.
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemoSeed()
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
