const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const csvPath = '/home/vinicius/pdv-completo/produtos.csv';
const csvContent = fs.readFileSync(csvPath, 'utf-8');
const lines = csvContent.trim().split('\n');
const products = lines.slice(1).map(line => {
  const parts = line.split(';');
  const nome = parts[0].trim();
  const desc = (parts[1] || '').trim();
  const price = parseFloat(parts[2]);
  const category = (parts[3] || '').trim();
  return { nome, desc, price, category };
}).filter(p => p.nome && !isNaN(p.price));

console.log(`Loaded ${products.length} products from CSV`);

const results = { success: [], failed: [] };
const userDataDir = '/tmp/ifood-profile';

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 300,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = context.pages()[0] || await context.newPage();

  async function clickByText(text, timeout = 10000) {
    try {
      const locator = page.locator(`button:has-text("${text}")`).first();
      await locator.waitFor({ timeout, state: 'visible' });
      await locator.click();
      return true;
    } catch (e) { return false; }
  }

  async function fillByPlaceholder(placeholder, text, timeout = 10000) {
    try {
      const locator = page.locator(`input[placeholder*="${placeholder}"]`).first();
      await locator.waitFor({ timeout, state: 'visible' });
      await locator.fill(text);
      return true;
    } catch (e) { return false; }
  }

  try {
    console.log('Navigating to iFood portal...');
    await page.goto('https://portal.ifood.com.br/menu/list', {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    console.log('Waiting for page to load...');
    await page.waitForTimeout(15000);

    // Check if login is needed
    const loginVisible = await page.locator('input[type="password"]').isVisible({ timeout: 3000 }).catch(() => false);
    if (loginVisible) {
      console.log('\n=== LOGIN NECESSARIO ===');
      console.log('Faca login no browser que abriu.');
      console.log('Aguardando 120 segundos para login manual...');
      await page.waitForTimeout(120000);
    }

    // Wait for cardapio
    console.log('Waiting for cardapio...');
    try {
      await page.waitForSelector('text=Cardapio', { timeout: 30000 });
      console.log('Cardapio loaded!');
    } catch (e) {
      console.log('Cardapio not found, waiting more...');
      await page.waitForTimeout(15000);
    }

    await page.waitForTimeout(3000);

    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      console.log(`\n[${i + 1}/${products.length}] ${p.nome} - R$ ${p.price}`);

      try {
        // Step 1: Click "Adicionar produto"
        let clicked = await clickByText('Adicionar produto', 5000);

        if (!clicked) {
          console.log('  Expanding category...');
          const openBtn = page.locator('button:has-text("Abrir categoria")').first();
          if (await openBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await openBtn.click();
            await page.waitForTimeout(2000);
          }
          clicked = await clickByText('Adicionar produto', 5000);
        }

        if (!clicked) {
          throw new Error('Adicionar produto button not found');
        }
        await page.waitForTimeout(2000);

        // Step 2: Search for product name
        const searchBox = page.locator('input, [role="combobox"]').first();
        await searchBox.click();
        await searchBox.fill(p.nome);
        await page.waitForTimeout(2000);

        // Step 3: Click "Criar novo"
        const createBtn = page.locator('button:has-text("Criar novo")').first();
        if (!await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          throw new Error('Criar novo button not found');
        }
        await createBtn.click();
        await page.waitForTimeout(2000);

        // Step 4: Click "Continuar"
        const continueBtn = page.locator('button:has-text("Continuar")').first();
        if (!await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          throw new Error('Continuar button not found');
        }
        await continueBtn.click();
        await page.waitForTimeout(2000);

        // Step 5: Type price
        const priceInput = page.locator('input').last();
        await priceInput.click();
        await priceInput.fill(p.price.toString());
        await page.waitForTimeout(1000);

        // Step 6: Click "Concluir"
        const concludeBtn = page.locator('button:has-text("Concluir")').first();
        if (!await concludeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          throw new Error('Concluir button not found or disabled');
        }
        await concludeBtn.click();
        await page.waitForTimeout(3000);

        // Check success
        const success = await page.locator('text=O produto foi adicionado').isVisible({ timeout: 5000 }).catch(() => false);
        if (success) {
          results.success.push(p);
          console.log('  OK');
        } else {
          results.failed.push(p);
          console.log('  FAIL - no success message');
        }
      } catch (err) {
        results.failed.push(p);
        console.log(`  FAIL - ${err.message}`);
      }

      await page.waitForTimeout(1000);
    }

  } catch (err) {
    console.error('Fatal error:', err.message);
  } finally {
    console.log(`\n=== RESULTS: ${results.success.length}/${products.length} success, ${results.failed.length} failed ===`);
    if (results.failed.length > 0) {
      console.log('Failed:', results.failed.map(p => p.nome).join(', '));
    }
    await context.close();
  }
})();