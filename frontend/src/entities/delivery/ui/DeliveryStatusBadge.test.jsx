import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DeliveryStatusBadge, {
  DELIVERY_TRANSITIONS,
  allowedTransitions,
  statusNeedsReason,
} from "./DeliveryStatusBadge.jsx";

// Este arquivo é o alarme que o comentário de `DeliveryStatusBadge.jsx` promete:
// a matriz `DELIVERY_TRANSITIONS` do balcão é uma CÓPIA de
// `DELIVERY_TRANSITIONS` do backend (`backend/src/domain/customer-order-state.ts`,
// usada por dispatch/deliver/fail/cancelamento). Se o backend ganhar uma
// transição nova, a lista daqui é a que precisa mudar — e o lugar de
// descobrir isso é um teste vermelho, não o 409 que o gerente leva na tela
// depois de escolher uma opção que o servidor recusa.
//
// Os valores esperados estão escritos um a um, à mão: um teste que copiasse a
// matriz do próprio módulo passaria mesmo com a matriz errada.

const STATUS = [
  ["awaiting_courier", "Aguardando", "bg-amber-500/15 text-amber-400"],
  ["out_for_delivery", "A caminho", "bg-sky-500/15 text-sky-400"],
  ["delivered", "Entregue", "bg-emerald-500 text-emerald-950"],
  ["failed", "Falhou", "bg-red-500/15 text-red-400"],
  ["cancelled", "Cancelada", "bg-stone-700/50 text-stone-400"],
];

describe("DeliveryStatusBadge — rótulo e cor de cada status", () => {
  for (const [status, label, classes] of STATUS) {
    it(`${status} → "${label}"`, () => {
      render(<DeliveryStatusBadge status={status} />);
      const badge = screen.getByText(label);
      expect(badge.className).toContain(classes);
    });
  }

  it("status desconhecido não some: mostra o cru e cai na cor de 'aguardando'", () => {
    render(<DeliveryStatusBadge status="saiu_pra_entregar" />);
    const badge = screen.getByText("saiu_pra_entregar");
    expect(badge.className).toContain("bg-amber-500/15 text-amber-400");
  });

  it("className do chamador entra junto das do status", () => {
    render(<DeliveryStatusBadge status="delivered" className="shrink-0" />);
    expect(screen.getByText("Entregue").className).toContain("shrink-0");
  });
});

describe("DeliveryStatusBadge — transições que o balcão pode fazer", () => {
  it("aguardando: sair em rota ou cancelar", () => {
    expect(allowedTransitions("awaiting_courier")).toEqual([
      { value: "out_for_delivery", label: "A caminho" },
      { value: "cancelled", label: "Cancelar entrega" },
    ]);
  });

  it("a caminho: entregar, falhar ou cancelar", () => {
    expect(allowedTransitions("out_for_delivery")).toEqual([
      { value: "delivered", label: "Marcar entregue" },
      { value: "failed", label: "Marcar falha" },
      { value: "cancelled", label: "Cancelar entrega" },
    ]);
  });

  it("falhou: só cancelar (o pedido segue aberto; de `failed` não se entrega)", () => {
    expect(allowedTransitions("failed")).toEqual([{ value: "cancelled", label: "Cancelar entrega" }]);
  });

  it("entregue e cancelada são terminais: sem saída, sem controle na tela", () => {
    expect(allowedTransitions("delivered")).toEqual([]);
    expect(allowedTransitions("cancelled")).toEqual([]);
  });

  it("status desconhecido não oferece nada (o backend é quem recusa)", () => {
    expect(allowedTransitions("saiu_pra_entregar")).toEqual([]);
  });

  it("a matriz é a mesma que o backend: 5 status, e nenhum terminal transiciona", () => {
    // Espelha `DELIVERY_TRANSITIONS` (domain/customer-order-state.ts).
    expect(Object.keys(DELIVERY_TRANSITIONS).sort()).toEqual([
      "awaiting_courier",
      "cancelled",
      "delivered",
      "failed",
      "out_for_delivery",
    ]);
    expect(DELIVERY_TRANSITIONS.delivered).toEqual([]);
    expect(DELIVERY_TRANSITIONS.cancelled).toEqual([]);
    // `out_for_delivery → cancelled` existe por causa do cancelamento pelo
    // gerente com o entregador em rota; `failed → cancelled`, porque o pedido
    // continua aberto depois da falha.
    expect(DELIVERY_TRANSITIONS.out_for_delivery.map((t) => t.value)).toEqual([
      "delivered",
      "failed",
      "cancelled",
    ]);
    expect(DELIVERY_TRANSITIONS.failed.map((t) => t.value)).toEqual(["cancelled"]);
  });
});

describe("DeliveryStatusBadge — quais status pedem motivo", () => {
  it("cancelar e falhar pedem motivo (é o texto que o cliente recebe)", () => {
    expect(statusNeedsReason("cancelled")).toBe(true);
    expect(statusNeedsReason("failed")).toBe(true);
  });

  it("os demais não pedem nada", () => {
    expect(statusNeedsReason("awaiting_courier")).toBe(false);
    expect(statusNeedsReason("out_for_delivery")).toBe(false);
    expect(statusNeedsReason("delivered")).toBe(false);
    // E nenhum outro status inventado.
    expect(statusNeedsReason("qualquer_coisa")).toBe(false);
  });
});
