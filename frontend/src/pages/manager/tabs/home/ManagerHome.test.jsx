import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  overviewReport: vi.fn(),
  listOrders: vi.fn(),
  setActiveId: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/entities/reports", () => ({
  browserTzOffset: () => 180,
  overviewReport: mocks.overviewReport,
  periodRange: () => ({ from: "2026-10-06", to: "2026-10-06" }),
}));
vi.mock("@/entities/order", () => ({ listOrders: mocks.listOrders }));
vi.mock("@/app/providers/auth", () => ({
  useAuth: () => ({
    session: { user: { name: "Ana Silva" } },
    storeSettings: { inventoryEnabled: true, purchaseEnabled: true, ifoodIntegrationEnabled: false },
  }),
}));
vi.mock("@/app/providers/nav", () => ({ useNav: () => ({ setActiveId: mocks.setActiveId }) }));

import ManagerHome from "./ManagerHome.jsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderHome() {
  mocks.overviewReport.mockResolvedValue({ totals: { totalSales: 250, orderCount: 5, avgTicket: 50 } });
  mocks.listOrders.mockResolvedValue({ data: [{ id: "a" }, { id: "b" }] });
  return render(<ManagerHome showToast={mocks.showToast} />);
}

describe("ManagerHome", () => {
  it("mostra o resumo do dia usando os dados dos relatórios e das comandas", async () => {
    renderHome();
    expect(screen.getByRole("heading", { name: /Ana/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/^R\$\s*250,00$/)).toBeTruthy());
    expect(screen.getByText("5", { selector: "p" })).toBeTruthy();
    expect(screen.getByText(/^R\$\s*50,00$/)).toBeTruthy();
    expect(screen.getByText("2", { selector: "p" })).toBeTruthy();
    expect(mocks.overviewReport).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-10-06", to: "2026-10-06", groupBy: "hour", tz: 180 }));
    expect(mocks.listOrders).toHaveBeenCalledWith("open");
  });

  it("mostra atalhos opcionais conforme os recursos habilitados e navega ao selecionar", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText(/^R\$\s*250,00$/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Estoque/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Compras/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /iFood/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Relatórios/ }));
    expect(mocks.setActiveId).toHaveBeenCalledWith("reports.overview");
  });

  it("permite atualizar e informa quando a API não retorna todos os indicadores", async () => {
    mocks.overviewReport.mockRejectedValue(new Error("Sem conexão"));
    mocks.listOrders.mockResolvedValue({ data: [] });
    render(<ManagerHome showToast={mocks.showToast} />);
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining("indicadores"), "error"));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar indicadores" }));
    await waitFor(() => expect(mocks.overviewReport).toHaveBeenCalledTimes(2));
  });
});
