import { describe, expect, it } from "vitest";
import { alertAgeLabel, alertSubtitle, canOpenAlert, groupAlertsByDay } from "./alertView.js";

const NOW = new Date("2026-09-28T15:00:00.000Z").getTime();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

describe("alertAgeLabel", () => {
  it("escala de minutos a dias", () => {
    expect(alertAgeLabel(ago(0), NOW)).toBe("agora");
    expect(alertAgeLabel(ago(4), NOW)).toBe("há 4 min");
    expect(alertAgeLabel(ago(59), NOW)).toBe("há 59 min");
    expect(alertAgeLabel(ago(60), NOW)).toBe("há 1 h");
    expect(alertAgeLabel(ago(26 * 60), NOW)).toBe("ontem");
    expect(alertAgeLabel(ago(72 * 60), NOW)).toBe("há 3 dias");
  });

  it("data inválida vira string vazia (não 'Invalid Date' na tela)", () => {
    expect(alertAgeLabel("lixo", NOW)).toBe("");
    expect(alertAgeLabel(undefined, NOW)).toBe("");
  });
});

describe("alertSubtitle", () => {
  it("usa o corpo que o backend montou", () => {
    expect(alertSubtitle({ body: "Entrega · página", channel: "web" })).toBe("Entrega · página");
    expect(alertSubtitle({ body: "iFood 1234", channel: "ifood" })).toBe("iFood 1234");
  });

  it("sem corpo, cai no rótulo do canal", () => {
    expect(alertSubtitle({ channel: "whatsapp" })).toBe("WhatsApp");
    expect(alertSubtitle({ channel: "web" })).toBe("Pedido online");
    // Canal desconhecido sem corpo: melhor não inventar texto.
    expect(alertSubtitle({ channel: "sms" })).toBeNull();
    expect(alertSubtitle({})).toBeNull();
  });
});

describe("canOpenAlert", () => {
  const open = { orderId: "o1", orderStatus: "open" };

  it("gerente e garçom abrem comanda aberta", () => {
    expect(canOpenAlert(open, "manager")).toBe(true);
    expect(canOpenAlert(open, "waiter")).toBe(true);
  });

  it("quem não tem tela de comandas só marca lido", () => {
    for (const role of ["cashier", "kitchen", "courier"]) {
      expect(canOpenAlert(open, role), role).toBe(false);
    }
  });

  it("comanda encerrada não abre (não há o que ver), e alerta sem comanda também", () => {
    expect(canOpenAlert({ orderId: "o1", orderStatus: "closed" }, "manager")).toBe(false);
    expect(canOpenAlert({ orderId: "o1", orderStatus: null }, "manager")).toBe(false);
    expect(canOpenAlert({ orderId: null, orderStatus: "open" }, "manager")).toBe(false);
    expect(canOpenAlert(null, "manager")).toBe(false);
  });
});

describe("groupAlertsByDay", () => {
  it("agrupa preservando a ordem da lista (mais recente primeiro)", () => {
    const hoje = new Date(2026, 8, 28, 10, 0, 0).toISOString();
    const ontem = new Date(2026, 8, 27, 22, 0, 0).toISOString();
    const groups = groupAlertsByDay(
      [
        { id: "a", createdAt: hoje },
        { id: "b", createdAt: hoje },
        { id: "c", createdAt: ontem },
      ],
      NOW
    );
    expect(groups.map((g) => g.label)).toEqual(["Hoje", "Ontem"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["c"]);
  });

  it("dia mais antigo vira data dd/mm", () => {
    const antigo = new Date(2026, 8, 10, 9, 0, 0).toISOString();
    const [group] = groupAlertsByDay([{ id: "x", createdAt: antigo }], NOW);
    expect(group.label).toMatch(/^\d{2}\/\d{2}$/);
  });

  it("lista vazia não gera grupo nenhum", () => {
    expect(groupAlertsByDay([], NOW)).toEqual([]);
  });
});
