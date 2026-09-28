// ============================================================
// Diagnóstico do portal iFood — mapeia seletores reais.
//
// Uso:
//   IFOOD_LOGIN=xxx IFOOD_PASSWORD=xxx IFOOD_HEADLESS=false node scripts/inspect-ifood.js
//
// Faz login automático, navega até Cardápio > Produtos, clica em
// "Novo produto" e captura os seletores do drawer de criação.
// ============================================================
import { chromium } from "playwright";

const HEADLESS = process.env.IFOOD_HEADLESS !== "false";
const IFOOD_LOGIN = process.env.IFOOD_LOGIN ?? "";
const IFOOD_PASSWORD = process.env.IFOOD_PASSWORD ?? "";

if (!IFOOD_LOGIN || !IFOOD_PASSWORD) {
  console.error("[inspect] Defina IFOOD_LOGIN e IFOOD_PASSWORD.");
  process.exit(1);
}

function randomDelay(min = 300, max = 1200) {
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

async function humanType(page, selector, text) {
  // Tenta clicar; se falhar (campo invisível), usa fill direto
  try {
    await page.click(selector, { timeout: 2000, delay: Math.random() * 100 });
    for (const char of text) {
      await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 20 });
    }
  } catch {
    await page.fill(selector, text);
  }
}

const browser = await chromium.launch({
  headless: HEADLESS,
  args: ["--disable-blink-features=AutomationControlled"],
});

const context = await browser.newContext({
  locale: "pt-BR",
  timezoneId: "America/Sao_Paulo",
  viewport: { width: 1920, height: 1080 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

const page = await context.newPage();

console.log("[inspect] Abrindo portal do iFood...");
await page.goto("https://portal.ifood.com.br/", { waitUntil: "domcontentloaded" });

// Espera a página de login carregar
console.log("[inspect] Esperando página de login...");
await page.waitForSelector('input[name="username"], input#username, input[type="email"]', { timeout: 20000, state: "attached" });

// Login automático
console.log("[inspect] Fazendo login...");
await humanType(page, 'input[name="username"], input#username, input[type="email"]', IFOOD_LOGIN);
await randomDelay(200, 600);
await page.click('button[type="submit"]');
await randomDelay(500, 1000);

// Senha
console.log("[inspect] Esperando campo de senha...");
await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000, state: "attached" });
await humanType(page, 'input[type="password"], input[name="password"]', IFOOD_PASSWORD);
await randomDelay(200, 600);
await page.click('button[type="submit"]');
await page.waitForLoadState("networkidle");
await randomDelay(1000, 2000);
console.log("[inspect] Login realizado.");

// Navega até Cardápio > Produtos
console.log("[inspect] Navegando até Cardápio > Produtos...");
await page.goto("https://portal.ifood.com.br/menu/list/products", { waitUntil: "networkidle" });
await randomDelay(1000, 2000);

// Clica em "Novo produto"
console.log("[inspect] Clicando em 'Novo produto'...");
await page.click('a[href*="new"], button:has-text("Novo produto")');
await page.waitForTimeout(3000);
console.log("[inspect] Drawer aberto. Capturando seletores...\n");

// Captura inputs visíveis
console.log("========== INPUTS ==========");
const inputs = await page.locator("input:visible, textarea:visible, select:visible").all();
for (const el of inputs) {
  const tag = await el.evaluate((n) => n.tagName.toLowerCase());
  const name = await el.getAttribute("name");
  const type = await el.getAttribute("type");
  const placeholder = await el.getAttribute("placeholder");
  const id = await el.getAttribute("id");
  const dataTestid = await el.getAttribute("data-testid");
  const className = await el.getAttribute("class");
  if (!placeholder?.includes("Buscar")) {
    console.log(`  [${tag}] name=${name} type=${type} placeholder=${placeholder} id=${id} data-testid=${dataTestid} class=${className?.slice(0, 60)}`);
  }
}

console.log("\n========== BOTÕES ==========");
const buttons = await page.locator("button:visible").all();
for (const b of buttons) {
  const text = (await b.innerText().catch(() => "")).trim();
  const type = await b.getAttribute("type");
  if (text) {
    console.log(`  type=${type} texto="${text.slice(0, 60)}"`);
  }
}

await browser.close();
console.log("\n[inspect] Navegador fechado.");
