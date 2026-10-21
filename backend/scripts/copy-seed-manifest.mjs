// Copia o catálogo de seeds para o `dist/`.
//
// POR QUE ISTO EXISTE: o `registry.ts` (leitura do manifesto) resolve o
// caminho do `manifest.json` a partir de `import.meta.url` — o mesmo código
// roda em `src` (tsx) e em `dist` (node). O `tsc` compila `.ts` e NÃO copia
// `.json`: sem esta cópia, `dist/infra/db/seeds/manifest.json` não existiria
// e o runner genérico (`dist/infra/db/seeds/apply.js`) quebraria na imagem de
// produção, onde só o `dist/` é copiado.
//
// O manifesto é DADO (o mesmo arquivo que a CLI Rust lê em runtime), então
// copiar é o certo — gerá-lo no build criaria duas fontes de verdade.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromDir = path.join(backendRoot, "src", "infra", "db", "seeds");
const toDir = path.join(backendRoot, "dist", "infra", "db", "seeds");

const ARQUIVOS = ["manifest.json", "manifest.schema.json"];

fs.mkdirSync(toDir, { recursive: true });
for (const arquivo of ARQUIVOS) {
  const origem = path.join(fromDir, arquivo);
  if (!fs.existsSync(origem)) {
    console.error(`[seeds] ${arquivo} não encontrado em ${fromDir} — o catálogo de seeds não vai para o dist/.`);
    process.exit(1);
  }
  fs.copyFileSync(origem, path.join(toDir, arquivo));
}
console.log(`[seeds] catálogo de seeds copiado para ${path.relative(backendRoot, toDir)}`);
