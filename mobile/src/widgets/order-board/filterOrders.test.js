// Testes do filtro/ordenação da lista de comandas (lógica pura, sem render).
import { emptyMessage, filterOrders, visibleChips } from "./filterOrders.js";

function order(partial = {}) {
  return {
    id: "o-" + Math.random().toString(36).slice(2, 7),
    status: "open",
    tableId: null,
    tableNumber: null,
    customerName: null,
    tabLabel: "Balcão 1",
    openedAt: "2026-01-01T10:00:00.000Z",
    closedAt: null,
    items: [],
    ...partial,
  };
}

describe("visibleChips", () => {
  it("sempre tem Todas/Abertas/Fechadas/Cliente", () => {
    const ids = visibleChips(false, false).map((c) => c.id);
    expect(ids).toEqual(["all", "open", "closed", "customer"]);
  });

  it("adiciona 'Com pronto' só com cozinha e 'Mesa' só com mesas", () => {
    expect(visibleChips(true, false).map((c) => c.id)).toContain("ready");
    expect(visibleChips(false, true).map((c) => c.id)).toContain("table");
    expect(visibleChips(false, false).map((c) => c.id)).not.toContain("ready");
    expect(visibleChips(false, false).map((c) => c.id)).not.toContain("table");
  });
});

describe("filterOrders", () => {
  const open = order({ status: "open", openedAt: "2026-01-01T10:00:00.000Z", items: [{ status: "pending" }] });
  const closed = order({ status: "closed", closedAt: "2026-01-02T10:00:00.000Z", items: [{ status: "delivered" }] });
  const ready = order({
    status: "open",
    tableId: "t1",
    tableNumber: 3,
    openedAt: "2026-01-01T11:00:00.000Z",
    items: [{ status: "ready" }],
  });
  const byTable = order({ status: "open", tableId: "t2", tableNumber: 5, items: [{ status: "pending" }] });
  const all = [open, closed, ready, byTable];

  it("aberta vem antes de fechada, e por horário dentro do mesmo status", () => {
    const result = filterOrders(all, { filter: "all" });
    expect(result.map((o) => o.status)).toEqual(["open", "open", "open", "closed"]);
    expect(result[0].tableNumber).toBe(3); // ready abriu 11:00 — mais recente primeiro
    expect(result[1].tableId).toBeNull(); // `open` (10:00) antes de byTable
    expect(result[2].tableNumber).toBe(5);
  });

  it("filtro 'open' e 'closed' cortam pelo status", () => {
    expect(filterOrders(all, { filter: "open" })).toHaveLength(3);
    expect(filterOrders(all, { filter: "closed" })).toHaveLength(1);
  });

  it("filtro 'ready' pega só comanda com item pronto", () => {
    expect(filterOrders(all, { filter: "ready" }).map((o) => o.id)).toEqual([ready.id]);
  });

  it("filtro 'table' vs 'customer' separa por ter mesa ou não", () => {
    expect(filterOrders(all, { filter: "table" }).map((o) => o.id)).toEqual([ready.id, byTable.id]);
    expect(filterOrders(all, { filter: "customer" }).map((o) => o.id)).toEqual([open.id, closed.id]);
  });

  it("busca por rótulo da comanda (mesa ou cliente)", () => {
    expect(filterOrders(all, { search: "balcão" }).map((o) => o.id)).toEqual([open.id, closed.id]);
    expect(filterOrders(all, { search: "Mesa 5" }).map((o) => o.id)).toEqual([byTable.id]);
    expect(filterOrders(all, { search: "inexistente" })).toHaveLength(0);
  });
});

describe("emptyMessage", () => {
  it("mensagem específica por filtro", () => {
    expect(emptyMessage("closed")).toContain("fechada");
    expect(emptyMessage("all")).toContain("Nenhuma comanda");
    expect(emptyMessage("open")).toContain("aberta");
  });
});