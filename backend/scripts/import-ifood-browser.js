// ============================================================
// Importação em massa de produtos para o iFood via navegador
// (Playwright) com técnicas anti-bot (stealth).
//
// Uso:
//   IFOOD_LOGIN=xxx IFOOD_PASSWORD=xxx node scripts/import-ifood-browser.js
//
// Variáveis de ambiente:
//   IFOOD_LOGIN      — e-mail ou CNPJ do portal
//   IFOOD_PASSWORD   — senha do portal
//   IFOOD_HEADLESS   — "true" (padrão) ou "false" para ver o navegador
// ============================================================
import { chromium } from "playwright";
import { db } from "../dist/infra/db/client.js";
import { products, categories } from "../dist/infra/db/schema.js";
import { eq } from "drizzle-orm";
import { runMigrations } from "../dist/infra/db/migrate.js";
import { loadMenu } from "../dist/infra/db/load-menu.js";

const IFOOD_LOGIN = process.env.IFOOD_LOGIN ?? "";
const IFOOD_PASSWORD = process.env.IFOOD_PASSWORD ?? "";
const HEADLESS = process.env.IFOOD_HEADLESS !== "false";

if (!IFOOD_LOGIN || !IFOOD_PASSWORD) {
  console.error("[import] Defina IFOOD_LOGIN e IFOOD_PASSWORD no ambiente.");
  process.exit(1);
}

// ---------- Utilitários de comportamento humano ----------
function randomDelay(min = 500, max = 2000) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min)
  );
}

async function humanType(page, selector, text) {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 20 });
  }
}

// ---------- Scripts stealth (injetados em todas as páginas) ----------
const STEALTH_SCRIPTS = [
  // Esconde navigator.webdriver
  () => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  },
  // Simula plugins do Chrome
  () => {
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
  },
  // Idiomas realistas
  () => {
    Object.defineProperty(navigator, "languages", {
      get: () => ["pt-BR", "pt", "en-US", "en"],
    });
  },
  // Permissions API realista
  () => {
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  },
];

async function importProducts() {
  console.log("[import] Conectando ao banco...");

  console.log("[import] Aplicando migrations...");
  runMigrations();

  console.log("[import] Carregando cardápio Unami...");
  loadMenu();

  console.log("[import] Carregando produtos...");
  const allProducts = await db.select().from(products).where(eq(products.active, true));
  console.log(`[import] ${allProducts.length} produtos ativos no cardápio.`);

  // ---------- Browser stealth ----------
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    colorScheme: "light",
  });

  // Injeta scripts stealth em todas as páginas
  await context.addInitScript(STEALTH_SCRIPTS[0]);
  await context.addInitScript(STEALTH_SCRIPTS[1]);
  await context.addInitScript(STEALTH_SCRIPTS[2]);
  await context.addInitScript(STEALTH_SCRIPTS[3]);

  const page = await context.newPage();

  console.log("[import] Acessando portal do iFood...");
  await page.goto("https://portal.ifood.com.br/", { waitUntil: "networkidle" });
  await randomDelay(1000, 3000);

  if (HEADLESS) {
    console.log("[import] Fazendo login automático...");
    // Seletores reais do portal iFood (ajustar após mapeamento)
    const emailSelector = 'input[type="email"], input[name="email"], input[placeholder*="e-mail" i], input[placeholder*="CNPJ" i]';
    const passwordSelector = 'input[type="password"], input[name="password"]';

    await page.waitForSelector(emailSelector, { timeout: 15000 });
    await humanType(page, emailSelector, IFOOD_LOGIN);
    await randomDelay(300, 800);

    await humanType(page, passwordSelector, IFOOD_PASSWORD);
    await randomDelay(300, 800);

    await page.click('button[type="submit"]');
    await page.waitForLoadState("networkidle");
    await randomDelay(1000, 2000);
    console.log("[import] Login realizado.");
  } else {
    console.log("[import] Faça login manualmente na janela que abriu.");
    console.log("[import] Após logar e ver a tela inicial, pressione ENTER aqui no terminal...");
    await new Promise((resolve) => {
      process.stdin.once("data", resolve);
    });
  }

  console.log("[import] Navegando para Catálogo > Produtos...");
  await page.goto("https://portal.ifood.com.br/catalog", { waitUntil: "networkidle" });
  await randomDelay(1000, 2000);

  let created = 0;
  let failed = 0;

  for (const product of allProducts) {
    try {
      console.log(`[import] Criando: ${product.name}...`);

      await page.goto("https://portal.ifood.com.br/catalog/new", { waitUntil: "networkidle" });
      await randomDelay(800, 1500);

      // Nome do produto
      await humanType(page, 'input[name="name"], input[placeholder*="nome" i]', product.name);
      await randomDelay(200, 500);

      // Descrição
      if (product.description) {
        await humanType(page, 'textarea[name="description"], textarea[placeholder*="descrição" i]', product.description);
        await randomDelay(200, 500);
      }

      // Preço
      if (product.price != null) {
        await humanType(page, 'input[name="price"], input[placeholder*="preço" i]', String(product.price));
        await randomDelay(200, 500);
      }

      // Categoria
      const categorySelect = page.locator('select[name="category"], [data-testid="category"]');
      if (await categorySelect.count() > 0) {
        await categorySelect.first().selectOption({ index: 1 });
        await randomDelay(200, 500);
      }

      // Salvar
      await page.click('button[type="submit"]:has-text("Salvar"), button:has-text("Salvar")');
      await page.waitForLoadState("networkidle");
      await randomDelay(500, 1000);

      created++;
      console.log(`[import] ✓ ${product.name} criado.`);
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
