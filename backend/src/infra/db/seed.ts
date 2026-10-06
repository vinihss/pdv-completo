// Seed de desenvolvimento — runner executável do seed BASE. O corpo mora em
// `seed-base.ts` (`runBaseSeed()`) para que `npm run seed:demo` reutilize o
// mesmo caminho importando-o; este arquivo só cuida de fechar o pool e sair
// com o código certo, como sempre fez.
//
// Rodar de novo num banco já populado é seguro: reconcilia apenas os usuários
// demo que faltam (por nome), sem tocar no restante. Nota (§14.3) no final.
import { closeDatabase } from "./client.js";
import { runBaseSeed } from "./seed-base.js";

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

// Nota (§14.3): em produção real (primeiro deploy do estabelecimento), este
// script NÃO deve rodar como está — ele cria dados fictícios de demonstração.
// O fluxo real é: rodar só a criação de store_settings (com dados reais do
// estabelecimento) + um usuário "manager" inicial com PIN temporário, e
// deixar o gerente cadastrar o resto (categorias, produtos, garçons) pela
// tela de Configurações. Esse script serve para ambiente de desenvolvimento
// e para os dados de demonstração deste protótipo. Rodar de novo num banco já
// populado é seguro: reconcilia apenas os usuários demo que faltam (por nome),
// sem tocar no restante.
