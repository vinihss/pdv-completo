import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Regras de arquitetura do FSD (docs/09-frontend-fsd.md). Este teste existe
// porque `npm run build` não pega nenhum destes casos: barrel desatualizado
// em pasta que ninguém importa, ou import direto de arquivo interno.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

// `relative` devolve o caminho com o separador do S.O. ("\" no Windows), mas
// toda comparação aqui — allowlists, sufixo de barrel, o nome do próprio
// arquivo — é escrita com "/". Sem normalizar, este arquivo não reprova no
// Windows: ele deixa de testar. Nenhum barrel casaria com "/index.js" (a
// suíte saía com "No test found") e `layerOf` devolveria o caminho inteiro,
// que nunca está no RANK, fazendo "camadas não apontam para cima" passar sem
// olhar nada. Um teste de arquitetura que roda vazio é pior do que um
// quebrado: parece cobertura verde e não cobre nada.
const posix = (p) => p.split(sep).join("/");
const rel = (f) => posix(relative(SRC, f));

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}
const allFiles = walk(SRC).filter((f) => !posix(f).includes("/node_modules/"));
const importsOf = (f) =>
  [...readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
const layerOf = (f) => rel(f).split("/")[0];

// 1. shared/api só pode conter infraestrutura — nunca API de domínio (as 14 que
//    moravam ali viraram entities na Fase 2). A lista abaixo é a allowlist de
//    infra: `http.js` (núcleo do PDV) e `cep.js` (ViaCEP, serviço público de
//    terceiro — não é do PDV, por isso não passa por `http.js`). Arquivo de
//    teste não é módulo e não entra na conta.
describe("shared/api contém apenas infraestrutura", () => {
  const files = existsSync(join(SRC, "shared/api")) ? readdirSync(join(SRC, "shared/api")) : [];
  const INFRA_ALLOWED = ["cep.js", "http.js"];
  it("só módulos de infraestrutura", () => {
    expect(files.filter((f) => !/\.test\.js$/.test(f)).sort()).toEqual(INFRA_ALLOWED);
  });
});

// 2. shared não pode conter vocabulário de domínio: nenhum arquivo de shared
//    pode ser chamado com um termo de negócio do PDV.
describe("shared não guarda vocabulário de domínio", () => {
  const TERMS = ["order", "comanda", "product", "table", "mesa", "delivery", "entrega",
                 "stock", "cash", "gaveta", "payment", "purchase", "supplier", "customer"];
  it("nenhum arquivo de shared com nome de domínio", () => {
    const offenders = [];
    for (const f of walk(join(SRC, "shared"))) {
      const base = relative(join(SRC, "shared"), f).toLowerCase();
      const hit = TERMS.find((t) => base.includes(t));
      if (hit) offenders.push(`${rel(f)} (${hit})`);
    }
    expect(offenders).toEqual([]);
  });
});

// Nomes realmente exportados por um arquivo (sem contar o default, tratado
// à parte pelo barrel).
function exportsOf(file) {
  const src = readFileSync(file, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g))
    names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    if (m[0].includes(" from ")) continue;            // re-export: é outro arquivo
    for (const n of m[1].split(",")) {
      const parts = n.trim().split(/\s+as\s+/);
      names.add(parts[parts.length - 1].trim());
    }
  }
  return names;
}
const hasDefault = (file) => /export\s+default\b/.test(readFileSync(file, "utf8"));

// 3. Todo barrel precisa declarar exports que realmente existem no arquivo
//    apontado, e nenhum export pode ficar de fora (barrel desatualizado).
describe("barrels declaram exatamente o que os arquivos exportam", () => {
  for (const bar of walk(SRC).filter((f) => rel(f).endsWith("/index.js"))) {
    it(rel(bar), () => {
      const src = readFileSync(bar, "utf8");
      const declared = new Set();
      const missing = [];      // nome declarado que o arquivo alvo não exporta
      const orphan = [];       // nome exportado pelo alvo e não declarado

      for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s+"([^"]+)"/g)) {
        const target = join(dirname(bar), m[2]);
        if (!existsSync(target)) { missing.push(`${m[2]} (arquivo não existe)`); continue; }
        const real = exportsOf(target);
        const def = hasDefault(target);
        for (const n of m[1].split(",")) {
          const parts = n.trim().split(/\s+as\s+/);
          const local = parts[0].trim();
          const alias = (parts[parts.length - 1] || parts[0]).trim();
          if (!local) continue;
          declared.add(alias);
          if (local === "default") { if (!def) missing.push(`${m[2]}: default`); }
          else if (!real.has(local)) missing.push(`${m[2]}: ${local}`);
        }
        // `export { X } from` só declara X; o resto do alvo não é obligation.
      }

      for (const m of src.matchAll(/export\s*\*\s*from\s+"([^"]+)"/g)) {
        const target = join(dirname(bar), m[1]);
        if (!existsSync(target)) { missing.push(`${m[1]} (arquivo não existe)`); continue; }
        for (const n of exportsOf(target)) declared.add(n);
      }

      // Re-export sem "from" (o próprio barrel como fonte) e o que os
      // arquivos-alvo exportam mas o barrel esqueceu.
      for (const m of src.matchAll(/export\s*\{([^}]+)\}(?!\s*from)/g)) {
        for (const n of m[1].split(",")) {
          const parts = n.trim().split(/\s+as\s+/);
          declared.add((parts[parts.length - 1] || parts[0]).trim());
        }
      }
      for (const imp of importsOf(bar)) {
        const target = join(dirname(bar), imp);
        if (!existsSync(target) || !/\.(js|jsx)$/.test(imp)) continue;
        for (const n of exportsOf(target)) if (!declared.has(n)) orphan.push(n);
      }

      expect({ missing, orphan }).toEqual({ missing: [], orphan: [] });
    });
  }
});

// 4. Imports entre camadas andam numa direção só. shared não importa nada de
//    domain; pages nunca é importado por feature/entity/shared.
//
//    Exceção documentada: `features/*` e `entities/*` podem importar
//    `@/app/providers/auth` (o hook `useAuth`). O contexto de sessão é
//    infraestrutura de app, mas é consumido por 13 features — colocá-lo em
//    `shared` faria shared depender de entities, o que é pior. A exceção é
//    listada aqui de propósito: qualquer OUTRO import de `@/app` continua
//    falhando, e esta linha é o ponto de revisão se um dia oauth virar
//    entity.
const APP_EXCEPTIONS = [/@\/app\/providers\//];
const isAllowedAppImport = (imp) => APP_EXCEPTIONS.some((re) => re.test(imp));

describe("dependências entre camadas", () => {
  it("camadas não apontam para cima", () => {
    const RANK = { app: 0, pages: 1, widgets: 2, features: 3, entities: 4, shared: 5 };
    const offenders = [];
    for (const f of allFiles) {
      const from = layerOf(f);
      if (!(from in RANK)) continue;
      for (const imp of importsOf(f)) {
        if (!imp.startsWith("@/")) continue;
        const to = imp.slice(2).split("/")[0];
        if (!(to in RANK)) continue;
        // shared é a base: não pode depender de nenhuma camada de domínio.
        if (from === "shared" && to !== "shared") offenders.push(`${rel(f)} -> @/${to}`);
        // pages nunca é importado por layer abaixo de pages.
        if (to === "pages" && RANK[from] > RANK.pages) offenders.push(`${rel(f)} -> @/pages`);
        // page não importa page: o que duas pages compartilham vira widget.
        // (O bloco de comandas do garçom e a aba "Comandas" do gerente é
        // exatamente esse caso — por isso vivem em widgets/order-board.)
        if (from === "pages" && to === "pages") offenders.push(`${rel(f)} -> @/${imp}`);
        // app só é consumido pelo próprio app e por pages — salvo a exceção de auth.
        if (to === "app" && RANK[from] > RANK.pages && !isAllowedAppImport(imp))
          offenders.push(`${rel(f)} -> ${imp}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// 5. Arquivos internos de entity só são alcançados pelo barrel da entity.
describe("imports de entity passam pela API pública", () => {
  it("nenhum consumidor importa entities/<x>/<subpasta> direto", () => {
    const offenders = [];
    for (const f of allFiles) {
      for (const imp of importsOf(f)) {
        if (/^@\/entities\/[a-z-]+\/(api|ui|model|lib)\//.test(imp)) offenders.push(`${rel(f)} -> ${imp}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// 6. Moeda tem uma implementação só. Regressão real: o cardápio do cliente
//    mostrava "R$ 1.234,56" (Intl pt-BR) e o garçom/caixa "R$ 1234.56"
//    (toFixed) — o mesmo valor, duas escritas. As exceções de toFixed(2) são
//    payload numérico de API, campo 54 do BR Code e <input type="number">.
describe("moeda tem fonte única", () => {
  const MONEY_ALLOWED = new Set([
    "features/orders/PaymentModal.jsx", // amount/received no payload
    "entities/payment/lib/pix.js", // campo 54 do BR Code
    "widgets/cash-drawer/CloseCashDrawerModal.jsx", // <input type="number">
  ]);

  it("nenhum toFixed(2) fora das exceções documentadas", () => {
    const offenders = [];
    for (const f of allFiles) {
      const relPath = rel(f);
      if (MONEY_ALLOWED.has(relPath)) continue;
      // este próprio arquivo contém o padrão que procura
      if (relPath === "__tests__/fsd-boundaries.test.js") continue;
      if (/toFixed\(\s*2\s*\)/.test(readFileSync(f, "utf8"))) offenders.push(relPath);
    }
    expect(offenders).toEqual([]);
  });

  it("nenhuma implementação local de formatação de moeda", () => {
    const offenders = [];
    for (const f of allFiles) {
      const relPath = rel(f);
      if (relPath === "shared/lib/money.js" || relPath === "__tests__/fsd-boundaries.test.js") continue;
      const src = readFileSync(f, "utf8");
      if (/^\s*(const|function)\s+(money|fmtMoney|fmt)\s*[=(]/m.test(src)) offenders.push(relPath);
    }
    expect(offenders).toEqual([]);
  });
});
