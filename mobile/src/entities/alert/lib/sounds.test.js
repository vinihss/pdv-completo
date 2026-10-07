// Preferência de som por dispositivo. O ponto do teste é a ASSINATURA: com o
// storage síncrono do app (`@/shared/lib/storage`) a leitura devolve booleano
// na hora — é o que `pages/courier/model/useNewDeliveryAlert` exige
// (`if (isAlertSoundEnabled())`); se voltasse a devolver Promise, a condição
// seria sempre verdadeira e "desligar o som" não desligaria nada.
import { storage } from "@/shared/lib/storage";
import {
  ALERT_REPEAT_MS,
  ALERT_SOUND_KEY,
  ALERT_SOUNDS,
  alertSound,
  isAlertSoundEnabled,
  playAlertSound,
  setAlertSoundEnabled,
} from "./sounds.js";

jest.mock("./audio.native", () => ({
  playNativeAlertSound: jest.fn(() => Promise.resolve(true)),
}));

const { playNativeAlertSound } = require("./audio.native");

describe("sons por tipo de alerta", () => {
  it("comanda nova é o único tipo hoje e tem rótulo", () => {
    expect(Object.keys(ALERT_SOUNDS)).toEqual(["order_created"]);
    expect(ALERT_SOUNDS.order_created.label).toBe("Comanda nova");
  });

  it("kind novo vindo do backend não é erro — usa o som de comanda", () => {
    expect(alertSound("tipo_que_nao_existe")).toBe(ALERT_SOUNDS.order_created);
  });

  it("playAlertSound toca o áudio nativo e devolve true", async () => {
    await expect(playAlertSound("order_created")).resolves.toBe(true);
    expect(playNativeAlertSound).toHaveBeenCalledTimes(1);
  });

  it("30s: tempo de terminar a comanda anterior, não de virar alarme de salão", () => {
    expect(ALERT_REPEAT_MS).toBe(30_000);
  });
});

describe("preferência de som por dispositivo", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("default é ligado (um alarme que nasce desligado não serve pro turno)", () => {
    expect(isAlertSoundEnabled()).toBe(true);
  });

  it("desligar persiste e volta a ligar — e a leitura é síncrona", () => {
    expect(setAlertSoundEnabled(false)).toBe(false);
    expect(storage.getItem(ALERT_SOUND_KEY)).toBe("off");
    expect(isAlertSoundEnabled()).toBe(false);
    setAlertSoundEnabled(true);
    expect(storage.getItem(ALERT_SOUND_KEY)).toBe("on");
    expect(isAlertSoundEnabled()).toBe(true);
  });

  it("a chave é por aparelho, não por usuário", () => {
    expect(ALERT_SOUND_KEY).toBe("pdv:alert-sound");
  });
});
