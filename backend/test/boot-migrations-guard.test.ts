// Guard de boot: se as migrations falharem, o app NÃO pode subir em
// produção/cloud. O `/health` só checa a CONEXÃO com o banco — não o schema
// —, então subir com o schema quebrado deixa o healthcheck VERDE e o portão
// do deploy aprova um app que quebra em toda query.
//
// A decisão mora em `deveAbortarBootPorMigration()` e o comportamento em
// `tratarFalhaDeMigrationNoBoot()` (src/http/server.ts) — as duas são
// testáveis sem subir o app e sem derrubar um banco.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deveAbortarBootPorMigration,
  tratarFalhaDeMigrationNoBoot,
} from "../src/http/server.js";

// `NODE_ENV` é lido em runtime (não no load do módulo), então o teste
// precisa isolar a env — o mesmo padrão de `test/tenant-isolation.test.ts`.
const ENV_KEYS = ["NODE_ENV"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Guard de boot — migrations falharam", () => {
  it("dev: NÃO aborta o boot (só avisa)", () => {
    process.env.NODE_ENV = "development";
    expect(deveAbortarBootPorMigration("local")).toBe(false);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => tratarFalhaDeMigrationNoBoot(new Error("relation does not exist"))).not.toThrow();
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain(
        "migrations serão aplicadas na próxima reinicialização",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("produção (NODE_ENV=production): ABORTA o boot", () => {
    process.env.NODE_ENV = "production";
    expect(deveAbortarBootPorMigration("local")).toBe(true);

    expect(() => tratarFalhaDeMigrationNoBoot(new Error("relation does not exist"))).toThrow(
      /migrations falharam/,
    );
  });

  it("cloud: ABORTA o boot mesmo sem NODE_ENV=production", () => {
    process.env.NODE_ENV = "development";
    expect(deveAbortarBootPorMigration("cloud")).toBe(true);

    expect(() => tratarFalhaDeMigrationNoBoot(new Error("relation does not exist"), "cloud")).toThrow(
      /migrations falharam/,
    );
  });

  it("sem argumento usa o deploymentMode do ambiente (local na suíte)", () => {
    process.env.NODE_ENV = "development";
    expect(deveAbortarBootPorMigration()).toBe(false);
  });
});
