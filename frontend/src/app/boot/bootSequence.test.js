import { describe, it, expect, vi } from "vitest";
import { BOOT_PHASE, BOOT_OUTCOME, runBootSequence } from "./bootSequence.js";

// A sequência de boot é o que impede o PDV de ficar preso numa tela de
// espera numa cozinha sem internet. Estes testes travam as três garantias:
// update que falha não bloqueia, health check é quem decide "sem conexão",
// e a ordem cloud (conectar → atualizar) não gasta timeout à toa.

function harness(overrides = {}) {
  const phases = [];
  const deps = {
    pingApi: vi.fn(async () => true),
    checkForUpdate: vi.fn(async () => ({ available: false })),
    installUpdate: vi.fn(async () => ({ ok: true })),
    relaunch: vi.fn(async () => true),
    ...overrides,
  };
  return { phases, deps, onPhase: (p) => phases.push(p) };
}

const seen = (phases) => phases.map((p) => p.phase);

describe("runBootSequence — sem update", () => {
  it("plano local: checa update, conecta e abre", async () => {
    const { phases, deps, onPhase } = harness();
    const result = await runBootSequence({ mode: "local", onPhase, deps });

    expect(result).toEqual({ outcome: BOOT_OUTCOME.READY });
    expect(seen(phases)).toEqual([BOOT_PHASE.CHECKING, BOOT_PHASE.CONNECTING, BOOT_PHASE.READY]);
    expect(deps.pingApi).toHaveBeenCalledTimes(1);
  });

  it("plano nuvem: testa a API antes de qualquer coisa (aviso de internet vem já)", async () => {
    const { phases, deps, onPhase } = harness();
    const result = await runBootSequence({ mode: "cloud", onPhase, deps });

    expect(result.outcome).toBe(BOOT_OUTCOME.READY);
    expect(seen(phases)).toEqual([BOOT_PHASE.CONNECTING, BOOT_PHASE.CHECKING, BOOT_PHASE.READY]);
  });

  it("checagem de update que estoura não impede a abertura", async () => {
    const deps = {
      pingApi: vi.fn(async () => true),
      checkForUpdate: vi.fn(async () => {
        throw new Error("sem internet");
      }),
      installUpdate: vi.fn(),
      relaunch: vi.fn(),
    };
    const phases = [];
    const result = await runBootSequence({ mode: "local", onPhase: (p) => phases.push(p), deps });

    expect(result.outcome).toBe(BOOT_OUTCOME.READY);
    expect(phases.some((p) => p.phase === BOOT_PHASE.OFFLINE)).toBe(false);
  });
});

describe("runBootSequence — sem sistema", () => {
  it("nuvem: API fora do ar bloqueia com aviso de internet e nem tenta update", async () => {
    const { phases, deps, onPhase } = harness({ pingApi: vi.fn(async () => false) });
    const result = await runBootSequence({ mode: "cloud", onPhase, deps });

    expect(result).toEqual({ outcome: BOOT_OUTCOME.OFFLINE, reason: "cloud" });
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(seen(phases)).toEqual([BOOT_PHASE.CONNECTING, BOOT_PHASE.OFFLINE]);
  });

  it("local: API fora do ar bloqueia com o aviso de sistema parado (update é opcional)", async () => {
    const { phases, deps, onPhase } = harness({ pingApi: vi.fn(async () => false) });
    const result = await runBootSequence({ mode: "local", onPhase, deps });

    expect(result).toEqual({ outcome: BOOT_OUTCOME.OFFLINE, reason: "local" });
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(seen(phases)).toEqual([
      BOOT_PHASE.CHECKING,
      BOOT_PHASE.CONNECTING,
      BOOT_PHASE.OFFLINE,
    ]);
  });
});

describe("runBootSequence — com update", () => {
  const found = {
    available: true,
    version: "0.3.0",
    notes: "correções",
    update: { fake: true },
  };

  it("mostra o progresso, instala e reabre o app", async () => {
    const installUpdate = vi.fn(async (_update, onProgress) => {
      onProgress({ downloaded: 5, total: 10, percent: 50 });
      onProgress({ downloaded: 10, total: 10, percent: 100 });
      return { ok: true };
    });
    const { phases, deps, onPhase } = harness({
      checkForUpdate: vi.fn(async () => found),
      installUpdate,
    });

    const result = await runBootSequence({ mode: "cloud", onPhase, deps });

    expect(result.outcome).toBe(BOOT_OUTCOME.RESTARTING);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    const updating = phases.filter((p) => p.phase === BOOT_PHASE.UPDATING);
    expect(updating.map((p) => p.percent)).toEqual([0, 50, 100]);
    // a versão nova aparece no splash desde o primeiro frame
    expect(updating.every((p) => p.version === "0.3.0")).toBe(true);
    expect(seen(phases).at(-1)).toBe(BOOT_PHASE.RESTARTING);
  });

  it("instalação que falha abre a versão atual em vez de travar", async () => {
    const { phases, deps, onPhase } = harness({
      checkForUpdate: vi.fn(async () => found),
      installUpdate: vi.fn(async () => ({ ok: false, reason: "sem espaço em disco" })),
    });

    const result = await runBootSequence({ mode: "local", onPhase, deps });

    expect(result.outcome).toBe(BOOT_OUTCOME.READY);
    expect(deps.relaunch).not.toHaveBeenCalled();
    expect(seen(phases)).toContain(BOOT_PHASE.FAILED_UPDATE);
    // e mesmo assim confirma que o sistema responde antes de abrir
    expect(deps.pingApi).toHaveBeenCalledTimes(1);
  });
});
