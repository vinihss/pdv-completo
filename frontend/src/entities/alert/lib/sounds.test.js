import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O áudio é stubado: o teste é da TABELA e da preferência, não do Web Audio
// (que não existe em jsdom). O `shared/lib/audio` tem suíte própria de contrato
// do envelope; aqui o que importa é "qual tom toca para qual kind".
const audio = vi.hoisted(() => ({ playTones: vi.fn(() => true) }));
vi.mock("@/shared/lib/audio", () => ({ playTones: audio.playTones, unlockAudio: vi.fn() }));

const { ALERT_SOUNDS, ALERT_REPEAT_MS, ALERT_SOUND_KEY, alertSound, playAlertSound, isAlertSoundEnabled, setAlertSoundEnabled } =
  await import("./sounds.js");

describe("tabela de sons por tipo de alerta", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => audio.playTones.mockClear());

  it("toda entrada tem tons com freq e janela válidas (senão o bip some)", () => {
    for (const [kind, sound] of Object.entries(ALERT_SOUNDS)) {
      expect(sound.label, kind).toBeTruthy();
      expect(sound.tones.length, kind).toBeGreaterThan(0);
      for (const tone of sound.tones) {
        expect(tone.freq, kind).toBeGreaterThan(0);
        expect(tone.freq, kind).toBeLessThan(20000); // acima disso é ultrassom
        expect(tone.duration, kind).toBeGreaterThan(0);
        expect(tone.at, kind).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("comanda nova é o único tipo hoje, com dois bipes (o segundo atrasado)", () => {
    expect(Object.keys(ALERT_SOUNDS)).toEqual(["order_created"]);
    const tones = ALERT_SOUNDS.order_created.tones;
    expect(tones).toHaveLength(2);
    expect(tones[1].at).toBeGreaterThan(tones[0].at);
  });

  it("playAlertSound mapeia o kind para os tons da tabela", () => {
    expect(playAlertSound("order_created")).toBe(true);
    expect(audio.playTones).toHaveBeenCalledWith(ALERT_SOUNDS.order_created.tones);
  });

  it("kind novo vindo do backend não é erro — usa o som de comanda", () => {
    // App velho em cache contra backend novo: tocar o som conhecido é melhor
    // que silêncio (que parece "não chegou nada").
    expect(alertSound("tipo_que_nao_existe")).toBe(ALERT_SOUNDS.order_created);
    expect(playAlertSound("tipo_que_nao_existe")).toBe(true);
  });

  it("audio indisponível devolve false em vez de estourar o alerta", () => {
    audio.playTones.mockReturnValueOnce(false);
    expect(playAlertSound("order_created")).toBe(false);
  });
});

describe("preferência de som por dispositivo", () => {
  beforeEach(() => localStorage.clear());

  it("default é ligado (um alarme que nasce desligado não serve pro turno)", () => {
    expect(isAlertSoundEnabled()).toBe(true);
  });

  it("desligar persiste e volta a ligar", () => {
    expect(setAlertSoundEnabled(false)).toBe(false);
    expect(localStorage.getItem(ALERT_SOUND_KEY)).toBe("off");
    expect(isAlertSoundEnabled()).toBe(false);
    setAlertSoundEnabled(true);
    expect(localStorage.getItem(ALERT_SOUND_KEY)).toBe("on");
    expect(isAlertSoundEnabled()).toBe(true);
  });

  it("a chave é por aparelho, não por usuário", () => {
    expect(ALERT_SOUND_KEY).toBe("pdv:alert-sound");
  });
});

describe("repetição do som", () => {
  it("30s: tempo de terminar a comanda anterior, não de virar alarme de salão", () => {
    expect(ALERT_REPEAT_MS).toBe(30_000);
  });
});
