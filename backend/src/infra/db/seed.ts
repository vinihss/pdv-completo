// Wrapper de compatibilidade do seed BASE.
//
// `npm run seed` (o script mais antigo do backend) continua apontando para
// este arquivo; a implementação do seed mora agora em
// `src/infra/db/seeds/base.ts`, junto do catálogo de seeds
// (`src/infra/db/seeds/manifest.json`). O catálogo declara esse seed com o id
// `base` e o script `seed:base`.
//
// Rodar de novo num banco já populado é seguro: reconcilia apenas os usuários
// demo que faltam (por nome), sem tocar no restante. Nota (§14.3) no final.
import { closeDatabase } from "./client.js";
import { runBaseSeed } from "./seeds/base.js";

export { runBaseSeed };

// CLI próprio. O guard é obrigatório: este arquivo é importado por quem
// precisa do `runBaseSeed` sem executar o seed (o `apply.ts` usa o módulo
// novo direto, mas nada impede um import futuro deste wrapper).
if (import.meta.url === `file://${process.argv[1]}`) {
  runBaseSeed()
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

// Nota (§14.3): em produção real (primeiro deploy do estabelecimento), este
// script NÃO deve rodar como está — ele cria dados fictícios de demonstração.
// O fluxo real é: rodar só a criação de store_settings (com dados reais do
// estabelecimento) + um usuário "manager" inicial com PIN temporário, e
// deixar o gerente cadastrar o resto (categorias, produtos, garçons) pela
// tela de Configurações. Esse script serve para ambiente de desenvolvimento
// e para os dados de demonstração deste protótipo (o seed `demo`, id `demo` no
// catálogo, é o que monta o histórico de 30 dias). Rodar de novo num banco já
// populado é seguro: reconcilia apenas os usuários demo que faltam (por nome),
// sem tocar no restante.
