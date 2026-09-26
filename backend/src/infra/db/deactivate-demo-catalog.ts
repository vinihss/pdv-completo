// Desativa o cardápio de demonstração do `npm run seed` (src/infra/db/seed.ts).
//
// Por que é um script e não uma migration: o seed grava as categorias e os
// produtos demo DEPOIS de `runMigrations()`, então um `UPDATE` dentro da
// migration nunca encontraria essas linhas em banco novo — e em banco já
// populado a suíte de testes (test/stock.test.ts cria "Batata frita" R$ 22,00,
// test/helpers.ts cria "Chopp 300ml" R$ 9,50) teria produto legítimo
// desativado por nome. Aqui a execução é explícita e na hora certa.
//
// Nada é apagado: os produtos viram active = 0, continuam com FK válida para
// order_item/stock_movement e podem ser reativados pelo cadastro do gerente.
//
//   npm run db:deactivate-demo
//   npm run db:deactivate-demo -- --dry-run
import { rawSqlite } from "./client.js";
import { runMigrations } from "./migrate.js";

// Nome + preço exatos do seed: o par evita derrubar um produto homônimo que o
// gerente tenha cadastrado depois com outro valor.
const DEMO_PRODUCTS: { name: string; price: number }[] = [
  { name: "Chopp 300ml", price: 9.5 },
  { name: "Caipirinha", price: 18 },
  { name: "X-Burger", price: 28 },
  { name: "Filé à parmegiana", price: 42 },
  { name: "Batata frita", price: 22 },
  { name: "Isca de peixe", price: 34 },
];

const DEMO_CATEGORIES = ["Bebidas", "Pratos", "Porções"];

type ProductRow = { id: string; name: string; price: number; active: number };
type CategoryRow = { id: string; name: string; ativos_fora_do_demo: number; active: number };

const dryRun = process.argv.slice(2).includes("--dry-run");

function demoProducts(): ProductRow[] {
  const byNameAndPrice = rawSqlite.prepare("SELECT id, name, price, active FROM product WHERE name = ? AND price = ?");
  return DEMO_PRODUCTS.flatMap((d) => byNameAndPrice.all(d.name, d.price) as ProductRow[]);
}

// Só desliga a categoria demo que, ignorando os próprios produtos demo, ficar
// sem nenhum produto ativo — se o gerente cadastrou algo dentro de "Bebidas",
// a categoria continua no ar.
function demoCategories(demoProductIds: string[]): CategoryRow[] {
  const semDemo = demoProductIds.length
    ? `p.id NOT IN (${demoProductIds.map(() => "?").join(", ")})`
    : "1 = 1";
  const stmt = rawSqlite.prepare(`
    SELECT c.id,
           c.name,
           c.active,
           (SELECT COUNT(*)
              FROM product p
             WHERE p.category_id = c.id AND p.active = 1 AND ${semDemo}) AS ativos_fora_do_demo
      FROM category c
     WHERE c.name = ?
  `);
  return DEMO_CATEGORIES.flatMap((n) => stmt.all(...demoProductIds, n) as CategoryRow[]);
}

function run() {
  runMigrations();

  const produtos = demoProducts();
  const categorias = demoCategories(produtos.map((p) => p.id));
  if (produtos.length === 0 && categorias.length === 0) {
    console.log("[demo] nada do seed demo encontrado — nada a fazer.");
    console.log("[demo] (o banco talvez nunca tenha rodado `npm run seed`)");
    return;
  }

  const produtosAtivos = produtos.filter((p) => p.active === 1);
  const categoriasAlvo = categorias.filter((c) => c.active === 1 && c.ativos_fora_do_demo === 0);

  console.log(`[demo] ${dryRun ? "dry-run: " : ""}produtos demo — ${produtos.length} encontrado(s), ${produtosAtivos.length} ativo(s)`);
  for (const p of produtos) {
    console.log(`[demo]   ${p.active === 1 ? "desativar" : "já inativo"}  ${p.name} — R$ ${p.price.toFixed(2)}`);
  }
  console.log(`[demo] categorias demo — ${categoriasAlvo.length} para desativar de ${categorias.length} encontrada(s)`);
  for (const c of categorias) {
    const alvo = categoriasAlvo.includes(c);
    console.log(
      `[demo]   ${alvo ? "desativar" : "manter"}      ${c.name} — ${c.ativos_fora_do_demo} produto(s) ativo(s) fora do demo`
    );
  }

  if (dryRun) {
    console.log("[demo] dry-run: nada foi alterado.");
  } else {
    rawSqlite.transaction(() => {
      for (const p of produtosAtivos) {
        rawSqlite.prepare("UPDATE product SET active = 0, updated_at = (current_timestamp) WHERE id = ?").run(p.id);
      }
      for (const c of categoriasAlvo) {
        rawSqlite.prepare("UPDATE category SET active = 0 WHERE id = ?").run(c.id);
      }
    })();
    console.log(`[demo] ${produtosAtivos.length} produto(s) e ${categoriasAlvo.length} categoria(s) desativados.`);
  }

  console.log("[demo] reinicie o backend (a listagem é cacheada por 120s) para a mudança aparecer.");
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
