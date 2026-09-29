import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAudioContext, isAudioUnlocked, playTones, unlockAudio, __resetAudioContext } from "./audio.js";

// jsdom não tem Web Audio: o contexto é um dublê que registra o que a
// biblioteca pediu (frequência, envelope, início/fim). O teste é do contrato
// com o browser — duas notas, ganho com rampa, sem estourar quando não há
// suporte. Classe de verdade (e não arrow) porque a biblioteca faz `new`.
// `state` começa "running": é o estado depois de um gesto do usuário.
class FakeAudioContext {
  constructor(state = "running") {
    this.state = state;
    this.currentTime = 10;
    this.destination = {};
    this.started = [];
    this.resume = vi.fn(async () => {
      this.state = "running";
    });
  }
  createOscillator() {
    const osc = {
      type: "sine",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      stop: vi.fn(),
      start: (at) => this.started.push({ osc, at }),
    };
    return osc;
  }
  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }
}

function stubAudioContext(ctx = new FakeAudioContext()) {
  vi.stubGlobal("AudioContext", class {
    constructor() {
      return ctx;
    }
  });
  return ctx;
}

beforeEach(() => {
  __resetAudioContext();
  vi.stubGlobal("AudioContext", undefined);
  delete window.webkitAudioContext;
});

afterEach(() => {
  __resetAudioContext();
  vi.unstubAllGlobals();
});

describe("getAudioContext", () => {
  it("cria uma vez só e reaproveita (o contexto é caro e stateful)", () => {
    const ctx = stubAudioContext();
    expect(getAudioContext()).toBe(ctx);
    expect(getAudioContext()).toBe(ctx);
    expect(isAudioUnlocked()).toBe(true);
  });

  it("sem Web Audio: `rethrow: false` devolve null e com rethrow lança", () => {
    expect(getAudioContext({ rethrow: false })).toBeNull();
    expect(() => getAudioContext()).toThrow(/Web Audio/);
  });
});

describe("unlockAudio", () => {
  it("resume um contexto suspenso (autoplay policy) e confirma", async () => {
    const ctx = stubAudioContext(new FakeAudioContext("suspended"));
    expect(await unlockAudio()).toBe(true);
    expect(ctx.resume).toHaveBeenCalled();
    expect(isAudioUnlocked()).toBe(true);
  });

  it("nunca lança — quem chama é um listener de gesto do usuário", async () => {
    expect(await unlockAudio()).toBe(false);
  });
});

describe("playTones", () => {
  it("agenda os dois bipes no relógio do contexto", () => {
    const ctx = stubAudioContext();
    const played = playTones([
      { freq: 880, at: 0, duration: 0.14, gain: 0.14 },
      { freq: 1174.7, at: 0.18, duration: 0.2 },
    ]);
    expect(played).toBe(true);
    expect(ctx.started).toHaveLength(2);
    expect(ctx.started[0].at).toBe(10); // currentTime + at 0
    expect(ctx.started[1].at).toBeCloseTo(10.18, 5);
    // O oscilador é ligado ao ganho e o ganho no destino — é o caminho que
    // faz o envelope existir.
    expect(ctx.started[0].osc.connect).toHaveBeenCalled();
    expect(ctx.started[0].osc.frequency.setValueAtTime).toHaveBeenCalledWith(880, 10);
    expect(ctx.started[0].osc.stop).toHaveBeenCalled();
  });

  it("at negativo é tratado como agora (não quebra o oscillator)", () => {
    const ctx = stubAudioContext();
    expect(playTones([{ freq: 440, at: -5, duration: 0.1 }])).toBe(true);
    expect(ctx.started[0].at).toBe(10);
  });

  it("lista vazia não cria contexto (nada a tocar)", () => {
    expect(playTones([])).toBe(false);
    expect(window.AudioContext).toBeUndefined();
  });

  it("sem suporte devolve false — o som é extra, o alerta é essencial", () => {
    expect(playTones([{ freq: 880, duration: 0.1 }])).toBe(false);
  });

  it("erro do browser na criação do oscilador não derruba o app", () => {
    const ctx = stubAudioContext();
    ctx.createOscillator = () => {
      throw new Error("AudioContext suspended by policy");
    };
    expect(playTones([{ freq: 880, duration: 0.1 }])).toBe(false);
  });
});
