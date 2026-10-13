/**
 * Ratchet de compatibilidade da composition root definitiva — ONDA 7.
 *
 * A composition root (`src/composition/build-app.ts`) NÃO deve re-exportar
 * use cases com os nomes legados (`export const <nome>Usecase = ...
 * .<nome>Usecase;`). As rotas recebem dependências por parâmetro via
 * `buildContainer()`. Se este arquivo passar a ter re-exports de use
 * cases, o ratchet falha — a rotas devem continuar recebendo deps.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_FILE = join(__dirname, "..", "src", "composition", "build-app.ts");

describe("composition-compat (ratchet)", () => {
  it("não re-exporta use cases legados da composition root definitiva", () => {
    const source = readFileSync(ROOT_FILE, "utf8");
    const legacy = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^export const \w+ = \w+Instances\.\w+Usecase;$/.test(line));
    expect(legacy).toEqual([]);
  });
});
