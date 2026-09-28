const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const csvPath = '/home/vinicius/pdv-completo/produtos.csv';
const progressPath = '/tmp/ifood-progress.json';
const userDataDir = '/tmp/ifood-browser-profile';

const csvContent = fs.readFileSync(csvPath, 'utf-8');
const lines = csvContent.trim().split('\n');
const allProducts = lines.slice(1).map(line => {
  const parts = line.split(';');
  const nome = parts[0].trim();
  const desc = (parts[1] || '').trim();
  const price = parseFloat(parts[2]);
  const category = (parts[3] || '').trim();
  return { nome, desc, price, category };
}).filter(p => p.nome && !isNaN(p.price));

let progress = { success: [], failed: [], lastIndex: -1 };
if (fs.existsSync(progressPath)) {
  progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
}

console.log(`Total products: ${allProducts.length}`);
console.log(`Already done: ${progress.success.length + progress.failed.length}`);
console.log(`Progress saved to: ${progressPath}`);

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function clickByText(page, text, timeout = 10000) {
  const locator = page.locator(`button:has-text("${text}")`).first();
  await locator.waitFor({ timeout, state: 'visible' });
  await locator.click();
}

async function typeInField(page, text, timeout = 10000) {
  const searchBox = page.locator('input[placeholder*="cardápio"], input[type="text"]').first();
  await searchBox.waitFor({ timeout, state: 'visible' });
  await searchBox.fill(text);
}

async function addProduct(page, product) {
  // Click "Adicionar produto" in Tete category
  await clickByText(page, 'Adicionar produto', 15000);
  await sleep(2000);

  // Type product name in search
  await typeInField(page, product.nome, 15000);
  await sleep(3000);

  // Click "Criar novo"
  await clickByText(page, 'Criar novo', 10000);
  await sleep(2000);

  // Click "Continuar"
  await clickByText(page, 'Continuar', 10000);
  await sleep(2000);

  // Type price
  const priceInput = page.locator('input').last();
  await priceInput.waitFor({ timeout: 10000, state: 'visible' });
  await priceInput.fill(product.price.toString().replace('.', ','));
  await sleep(1000);

  // Click "Concluir"
  await clickByText(page, 'Concluir', 10000);
  await sleep(3000);

  // Check success
  const success = await page.locator('text=O produto foi adicionado').isVisible({ timeout: 5000 }).catch(() => false);
  return success;
}

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('\nNavigating to iFood portal...');
  let retries = 3;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto('https://portal.ifood.com.br/menu/list', {
        waitUntil: 'domcontentloaded',
        timeout: 90000
      });
      break;
    } catch (err) {
      console.log(`  Attempt ${attempt} failed: ${err.message.split('\n')[0]}`);
      if (attempt === retries) throw err;
      await sleep(5000);
    }
  }

  console.log('Waiting for login (90 seconds)...');
  console.log('Please log in manually in the browser window that opened.');
  console.log('The script will continue automatically after login.\n');

  // Wait for login - detect by checking for "Cardápio" text and absence of login form
  let loggedIn = false;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const hasCardapio = await page.locator('text=Cardápio').isVisible().catch(() => false);
    const hasPassword = await page.locator('input[type="password"]').isVisible().catch(() => false);
    if (hasCardapio && !hasPassword) {
      loggedIn = true;
      console.log('Login detected!');
      break;
    }
    console.log(`Waiting for login... (${(i + 1) * 5}s)`);
  }

  if (!loggedIn) {
    console.error('Login not detected. Please run the script again.');
    process.exit(1);
  }

  // Wait for page to fully load
  await sleep(5000);

  const startIndex = Math.max(0, progress.lastIndex + 1);
  console.log(`\nStarting from product ${startIndex + 1}/${allProducts.length}\n`);

  for (let i = startIndex; i < allProducts.length; i++) {
    const p = allProducts[i];
    console.log(`[${i + 1}/${allProducts.length}] ${p.nome} - R$ ${p.price}`);

    try {
      const success = await addProduct(page, p);
      if (success) {
        progress.success.push({ index: i, ...p });
        console.log('  OK');
      } else {
        progress.failed.push({ index: i, ...p, reason: 'no success message' });
        console.log('  FAIL - no success message');
      }
    } catch (err) {
      progress.failed.push({ index: i, ...p, reason: err.message });
      console.log(`  FAIL - ${err.message}`);
    }

    progress.lastIndex = i;
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));

    await sleep(1000);
  }

  console.log(`\n=== FINAL RESULTS ===`);
  console.log(`Success: ${progress.success.length}/${allProducts.length}`);
  console.log(`Failed: ${progress.failed.length}/${allProducts.length}`);
  if (progress.failed.length > 0) {
    console.log('\nFailed products:');
    progress.failed.forEach(f => console.log(`  - ${f.nome}: ${f.reason}`));
  }

  await context.close();
})();
