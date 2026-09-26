import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusBadge } from "@/entities/order";

describe("StatusBadge", () => {
  it("traduz os status de item de comanda", () => {
    for (const [status, label] of [
      ["ordered", "Em preparo"],
      ["ready", "Pronto"],
      ["delivered", "Entregue"],
      // cancelOrder marca como "cancelled" todo item ainda não entregue
      ["cancelled", "Cancelado"],
    ]) {
      render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it("não devolve o status cru em inglês para cancelado", () => {
    // Regressão: 'cancelled' não estava no dicionário e caía no fallback,
    // aparecendo como "cancelled" num badge cinza de "Em preparo".
    render(<StatusBadge status="cancelled" />);
    expect(screen.queryByText("cancelled")).toBeNull();
  });

  it("cai no dicionário com status desconhecido em vez de quebrar", () => {
    render(<StatusBadge status="algum_status_novo" />);
    expect(screen.getByText("algum_status_novo")).toBeDefined();
  });
});
