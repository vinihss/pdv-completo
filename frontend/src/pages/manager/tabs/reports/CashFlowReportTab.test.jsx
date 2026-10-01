import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// A tela de Fluxo de caixa deixou de ser o rodapé do relatório de pedidos: os
// quatro relatórios são telas independentes, e o teste precisa cobrir a que o
// caixa virou — inclusive a sessão ABERTA, que é onde a soma de "esperado"
// estoura (foi a regressão A que mantivemos coberta).
vi.mock("@/entities/reports", async (importOriginal) => ({
  ...(await importOriginal()),
  salesReport: vi.fn(),
}));
vi.mock("@/entities/cash", async (importOriginal) => ({
  ...(await importOriginal()),
  getCashDrawerSummary: vi.fn(),
}));

import { salesReport } from "@/entities/reports";
import { getCashDrawerSummary } from "@/entities/cash";
import CashFlowReportTab from "./CashFlowReportTab.jsx";

function cashFixture(openSession) {
  const sessions = [];
  if (openSession) {
    sessions.push({
      id: "c-open",
      status: "open",
      openedAt: "2026-09-24T19:00:00.000Z",
      openedByName: "Caixa Teste",
      openingAmount: 100,
      cashSalesTotal: 19,
      expected: 119,
      counted: null,
      difference: null,
    });
  }
  sessions.push({
    id: "c-closed",
    status: "closed",
    openedAt: "2026-09-23T19:00:00.000Z",
    openedByName: "Caixa Teste",
    closedAt: "2026-09-23T23:30:00.000Z",
    openingAmount: 50,
    cashSalesTotal: 0,
    expected: 54,
    counted: 54,
    difference: 0,
  });
  return {
    sessions,
    totalOpening: 150,
    totalSales: 19,
    openCount: openSession ? 1 : 0,
    openExpected: openSession ? 119 : 0,
    totalExpected: 54,
    totalCounted: 54,
    totalDifference: 0,
  };
}

describe("CashFlowReportTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    salesReport.mockResolvedValue({ summary: {}, total: 0, data: [] });
  });

  it("renderiza com uma sessão aberta no período sem quebrar (regressão A)", async () => {
    getCashDrawerSummary.mockResolvedValue(cashFixture(true));

    render(<CashFlowReportTab showToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("em aberto")).toBeDefined();
      expect(screen.getByText(/1 sessão\(ões\) em aberto/)).toBeDefined();
    });
    // A sessão fechada aparece com a diferença OK
    expect(screen.getByText("esperado R$ 54,00")).toBeDefined();

    expect(getCashDrawerSummary).toHaveBeenCalled();
    const params = getCashDrawerSummary.mock.calls[0][0];
    expect(params.tz).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("renderiza só sessões fechadas sem aviso de em aberto", async () => {
    getCashDrawerSummary.mockResolvedValue(cashFixture(false));

    render(<CashFlowReportTab showToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Sessões \(1\)/)).toBeDefined();
      expect(screen.queryByText(/em aberto/)).toBeNull();
    });
  });

  it("não chama o relatório de vendas — as telas são independentes", async () => {
    getCashDrawerSummary.mockResolvedValue(cashFixture(false));

    render(<CashFlowReportTab showToast={vi.fn()} />);

    await waitFor(() => expect(getCashDrawerSummary).toHaveBeenCalled());
    // Antes do submenu, a única tela de relatórios buscava vendas E caixa; o
    // gerente agora abre cada uma separadamente.
    expect(salesReport).not.toHaveBeenCalled();
  });
});