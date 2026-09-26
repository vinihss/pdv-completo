// ============================================================
// Importação em massa de produtos para o iFood via navegador
// (Playwright). Automatiza o Portal do Parceiro iFood.
//
// Uso:
//   node scripts/import-ifood-browser.js
//
// Variáveis de ambiente (backend/.env):
//   IFOOD_LOGIN    — e-mail ou CNPJ do portal
//   IFOOD_PASSWORD — senha do portal
//
// O script abre o navegador (headless=false para você ver o fluxo),
// faz login, e cadastra os produtos do cardápio Unami em massa.
// ============================================================
import { chromium } from "playwright";
import { db } from "../dist/infra/db/client.js";
import { products, categories } from "../dist/infra/db/schema.js";
import { eq } from "drizzle-orm";
import { runMigrations } from "../dist/infra/db/migrate.js";
import { loadMenu } from "../dist/infra/db/load-menu.js";

const IFOOD_LOGIN = process.env.IFOOD_LOGIN ?? "";
const IFOOD_PASSWORD = process.env.IFOOD_PASSWORD ?? "";

if (!IFOOD_LOGIN || !IFOOD_PASSWORD) {
  console.error("[import] Defina IFOOD_LOGIN e IFOOD_PASSWORD no ambiente.");
  process.exit(1);
}

async function importProducts() {
  console.log("[import] Conectando ao banco...");

  console.log("[import] Aplicando migrations...");
  runMigrations();

  console.log("[import] Carregando cardápio Unami...");
  loadMenu();

  console.log("[import] Carregando produtos...");
  const allProducts = await db.select().from(products).where(eq(products.active, true));
  console.log(`[import] ${allProducts.length} produtos ativos no cardápio.`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();

  console.log("[import] Acessando portal do iFood...");
  await page.goto("https://portal.ifood.com.br/", { waitUntil: "networkidle" });

  console.log("[import] Faça login manualmente na janela que abriu.");
  console.log("[import] Após logar e ver a tela inicial, pressione ENTER aqui no terminal...");

  await new Promise((resolve) => {
    process.stdin.once("data", resolve);
  });

  console.log("[import] Navegando para Catálogo > Produtos...");
  await page.goto("https://portal.ifood.com.br/catalog", { waitUntil: "networkidle" });

  let created = 0;
  let failed = 0;

  for (const product of allProducts) {
    try {
      console.log(`[import] Criando: ${product.name}...`);

      await page.goto("https://portal.ifood.com.br/catalog/new", { waitUntil: "networkidle" });

      // Nome do produto
      await page.fill('input[name="name"], input[placeholder*="nome" i]', product.name);

      // Descrição
      if (product.description) {
        await page.fill('textarea[name="description"], textarea[placeholder*="descrição" i]', product.description);
      }

      // Preço
      if (product.price != null) {
        await page.fill('input[name="price"], input[placeholder*="preço" i]', String(product.price));
      }

      // Categoria (seleciona a primeira ou cria)
      // Ajuste os seletores conforme a estrutura real do portal
      const categorySelect = page.locator('select[name="category"], [data-testid="category"]');
      if (await categorySelect.count() > 0) {
        await categorySelect.first().selectOption({ index: 1 });
      }

      // Salvar
      await page.click('button[type="submit"]:has-text("Salvar"), button:has-text("Salvar")');

      await page.waitForLoadState("networkidle");
      created++;
      console.log(`[import] ✓ ${product.name} criado.`);

      // Delay para não sobrecarregar
      await page.waitForTimeout(1000);
    } catch (err) {
      failed++;
      console.error(`[import] ✗ Falha ao criar ${product.name}: ${err.message}`);
    }
  }

  console.log("");
  console.log("============================================================");
  console.log(` IMPORTAÇÃO CONCLUÍDA`);
  console.log(`  Criados: ${created}`);
  console.log(`  Falhas:  ${failed}`);
  console.log("============================================================");

  await browser.close();
}

importProducts().catch((err) => {
  console.error("[import] Erro fatal:", err);
  process.exit(1);
});
