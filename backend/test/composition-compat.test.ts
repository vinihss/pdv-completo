/**
 * Ratchet de compatibilidade da composition root.
 *
 * Conta os re-exports "legados" de use cases em
 * `src/infra/composition/default-usecases.ts` (padrão
 * `export const <nome>Usecase = <inst>.<nome>Usecase;`). Ondas futuras
 * (http por parâmetro) removem essas linhas — o número nunca pode
 * crescer além deste limite sem que a intenção seja revisada.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_COMPOSITION_FILE = join(__dirname, "..", "src", "infra", "composition", "default-usecases.ts");

describe("composition-compat (ratchet)", () => {
  it("não cresce o número de re-exports legados do composition root", () => {
    const source = readFileSync(ROOT_COMPOSITION_FILE, "utf8");
    const legacy = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^export const \w+ = \w+Instances\.\w+Usecase;$/.test(line));
    // Hoje só `getStoreSettingsUsecase` sobrevive (consumido por server.ts
    // enquanto o refactor http não migrar o chamador). Onda 7 deve levar a 0.
    expect(legacy.length).toBeLessThanOrEqual(1);
  });
});
