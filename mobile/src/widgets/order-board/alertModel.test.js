// Alertas do sino do garçom: rótulos/itens e a preferência de som persistida.
import { storage } from "@/shared/lib/storage";
import {
  ALERT_SOUND_KEY,
  alertAgeLabel,
  alertSubtitle,
  canOpenAlert,
  groupAlertsByDay,
  isAlertSoundEnabled,
  setAlertSoundEnabled,
} from "./alertModel.js";

describe("alertAgeLabel", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("agora, minutos, horas, dias e ontem", () => {
    expect(alertAgeLabel(new Date(now - 30_000).toISOString(), now)).toBe("agora");
    expect(alertAgeLabel(new Date(now - 4 * 60_000).toISOString(), now)).toBe("há 4 min");
    expect(alertAgeLabel(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe("há 2 h");
    expect(alertAgeLabel(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("há 3 dias");
    expect(alertAgeLabel(new Date(now - 86_400_000).toISOString(), now)).toBe("ontem");
  });

  it("sem data válida devolve string vazia", () => {
    expect(alertAgeLabel("não é data", now)).toBe("");
  });
});

describe("alertSubtitle", () => {
  it("corpo tem prioridade; sem corpo usa o canal legível", () => {
    expect(alertSubtitle({ body: "pediu 2 porções", channel: "web" })).toBe("pediu 2 porções");
    expect(alertSubtitle({ channel: "whatsapp" })).toBe("WhatsApp");
    expect(alertSubtitle({ channel: "balcao" })).toBe("Comanda");
    expect(alertSubtitle({ channel: "ifood" })).toBe("iFood");
    expect(alertSubtitle({})).toBeNull();
  });
});

describe("canOpenAlert", () => {
  const base = { orderId: "abc", orderStatus: "open" };

  it("só comanda aberta e papel garçom/gerente", () => {
    expect(canOpenAlert(base, "waiter")).toBe(true);
    expect(canOpenAlert(base, "manager")).toBe(true);
    expect(canOpenAlert({ ...base, orderStatus: "closed" }, "waiter")).toBe(false);
    expect(canOpenAlert({ ...base }, "kitchen")).toBe(false);
    expect(canOpenAlert({ ...base, orderId: null }, "waiter")).toBe(false);
    expect(canOpenAlert(null, "waiter")).toBe(false);
  });
});

describe("groupAlertsByDay", () => {
  const d = (dayOffset, h = 10) => new Date(Date.UTC(2026, 0, 1 + dayOffset, h)).getTime();

  it("agrupa Hoje / Ontem e agrupa adjacentes", () => {
    const groups = groupAlertsByDay(
      [
        { id: "a", createdAt: d(0, 10) },
        { id: "b", createdAt: d(0, 11) },
        { id: "c", createdAt: d(-1, 9) },
        { id: "e", createdAt: d(-3, 8) },
      ],
      d(0, 12)
    );
    expect(groups.map((g) => g.label)).toEqual(["Hoje", "Ontem", "29/12"]);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1, 1]);
  });
});

describe("preferência de som", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("default ligado, desliga/liga persistindo a chave do web", () => {
    expect(isAlertSoundEnabled()).toBe(true);
    setAlertSoundEnabled(false);
    expect(storage.getItem(ALERT_SOUND_KEY)).toBe("off");
    expect(isAlertSoundEnabled()).toBe(false);
    setAlertSoundEnabled(true);
    expect(isAlertSoundEnabled()).toBe(true);
  });
});