import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/entities/reports", () => ({
  salesReport: vi.fn(),
}));
vi.mock("@/entities/cash", () => ({
  getCashDrawerSummary: vi.fn(),
}));

import { salesReport } from "@/entities/reports";
import { getCashDrawerSummary } from "@/entities/cash";
import ReportsTab from "./ReportsTab.jsx";

const reportFixture = {
  summary: {
    totalRevenue: 38,
    orderCount: 2,
    avgTicket: 19,
    changeTotal: 1,
    byPaymentMethod: { cash: 38 },
  },
  total: 2,
  data: [
    { orderId: "o-1", label: "Mesa 1", closedAt: "2026-09-24T21:00:00.000Z", paymentMethod: "Dinheiro", total: 19 },
    { orderId: "o-2", label: "Mesa 2", closedAt: "2026-09-24T21:30:00.000Z", paymentMethod: "Dinheiro", total: 19 },
  ],
};

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

describe("ReportsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    salesReport.mockResolvedValue(reportFixture);
  });

  it("renderiza com uma sessão aberta no período sem quebrar (regressão A)", async () => {
    getCashDrawerSummary.mockResolvedValue(cashFixture(true));

    render(<ReportsTab showToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("em aberto")).toBeDefined();
      expect(screen.getByText(/1 sessão\(ões\) em aberto/)).toBeDefined();
    });
    // A sessão fechada aparece com a diferença OK
    expect(screen.getByText("esperado R$ 54.00")).toBeDefined();

    expect(getCashDrawerSummary).toHaveBeenCalled();
    const params = getCashDrawerSummary.mock.calls[0][0];
    expect(params.tz).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("renderiza só sessões fechadas sem aviso de em aberto", async () => {
    getCashDrawerSummary.mockResolvedValue(cashFixture(false));

    render(<ReportsTab showToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Fluxo de caixa \(1\)/)).toBeDefined();
      expect(screen.queryByText(/em aberto/)).toBeNull();
    });
  });
});