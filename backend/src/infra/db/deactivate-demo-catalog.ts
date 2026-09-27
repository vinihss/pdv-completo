// Desativa o cardápio de demonstração do `npm run seed` (src/infra/db/seed.ts).
//
// Por que é um script e não uma migration: o seed grava as categorias e os
// produtos demo DEPOIS de `runMigrations()`, então um `UPDATE` dentro da
// migration nunca encontraria essas linhas em banco novo — e em banco já
// populado a suíte de testes (test/stock.test.ts cria "Batata frita" R$ 22,00,
// test/helpers.ts cria "Chopp 300ml" R$ 9,50) teria produto legítimo
// desativado por nome. Aqui a execução é explícita e na hora certa.
//
// Nada é apagado: os produtos viram active = false, continuam com FK válida
// para order_item/stock_movement e podem ser reativados pelo cadastro do
// gerente.
//
//   npm run db:deactivate-demo
//   npm run db:deactivate-demo -- --dry-run
import { and, count, eq, notInArray } from "drizzle-orm";
import { db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { categories, products } from "./schema.js";

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

type ProductRow = { id: string; name: string; price: number; active: boolean };
type CategoryRow = { id: string; name: string; ativosForaDoDemo: number; active: boolean };

const dryRun = process.argv.slice(2).includes("--dry-run");

async function demoProducts(): Promise<ProductRow[]> {
  const rows: ProductRow[] = [];
  for (const demo of DEMO_PRODUCTS) {
    const found = await db
      .select({ id: products.id, name: products.name, price: products.price, active: products.active })
      .from(products)
      .where(and(eq(products.name, demo.name), eq(products.price, demo.price)));
    rows.push(...found);
  }
  return rows;
}

// Só desliga a categoria demo que, ignorando os próprios produtos demo, ficar
// sem nenhum produto ativo — se o gerente cadastrou algo dentro de "Bebidas",
// a categoria continua no ar.
async function demoCategories(demoProductIds: string[]): Promise<CategoryRow[]> {
  const rows: CategoryRow[] = [];
  for (const name of DEMO_CATEGORIES) {
    const activeOutsideDemo = and(
      eq(products.categoryId, categories.id),
      eq(products.active, true),
      // notInArray com lista vazia geraria "IN ()" — sem filtro nesse caso.
      ...(demoProductIds.length ? [notInArray(products.id, demoProductIds)] : []),
    );
    const found = await db
      .select({
        id: categories.id,
        name: categories.name,
        active: categories.active,
        // count() sobre coluna do join: 0 quando a categoria não tem
        // produto ativo fora do demo (COUNT Ignora NULL do LEFT JOIN).
        ativosForaDoDemo: count(products.id),
      })
      .from(categories)
      .leftJoin(products, activeOutsideDemo)
      .where(eq(categories.name, name))
      .groupBy(categories.id);
    rows.push(...found);
  }
  return rows;
}

async function run() {
  await runMigrations();

  const produtos = await demoProducts();
  const categorias = await demoCategories(produtos.map((p) => p.id));
  if (produtos.length === 0 && categorias.length === 0) {
    console.log("[demo] nada do seed demo encontrado — nada a fazer.");
    console.log("[demo] (o banco talvez nunca tenha rodado `npm run seed`)");
    return;
  }

  const produtosAtivos = produtos.filter((p) => p.active);
  const categoriasAlvo = categorias.filter((c) => c.active && c.ativosForaDoDemo === 0);

  console.log(`[demo] ${dryRun ? "dry-run: " : ""}produtos demo — ${produtos.length} encontrado(s), ${produtosAtivos.length} ativo(s)`);
  for (const p of produtos) {
    console.log(`[demo]   ${p.active ? "desativar" : "já inativo"}  ${p.name} — R$ ${p.price.toFixed(2)}`);
  }
  console.log(`[demo] categorias demo — ${categoriasAlvo.length} para desativar de ${categorias.length} encontrada(s)`);
  for (const c of categorias) {
    const alvo = categoriasAlvo.includes(c);
    console.log(
      `[demo]   ${alvo ? "desativar" : "manter"}      ${c.name} — ${c.ativosForaDoDemo} produto(s) ativo(s) fora do demo`
    );
  }

  if (dryRun) {
    console.log("[demo] dry-run: nada foi alterado.");
  } else {
    await db.transaction(async (tx) => {
      for (const p of produtosAtivos) {
        await tx
          .update(products)
          .set({ active: false, updatedAt: new Date().toISOString() })
          .where(eq(products.id, p.id));
      }
      for (const c of categoriasAlvo) {
        await tx.update(categories).set({ active: false }).where(eq(categories.id, c.id));
      }
    });
    console.log(`[demo] ${produtosAtivos.length} produto(s) e ${categoriasAlvo.length} categoria(s) desativados.`);
  }

  console.log("[demo] reinicie o backend (a listagem é cacheada por 120s) para a mudança aparecer.");
}

try {
  await run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
