import { describe, it, expect } from "vitest";
import { orderItemCounts, orderTotal, pendingItems } from "./order.js";

const order = {
  items: [
    { status: "ordered", unitPrice: 10, quantity: 1 },
    { status: "ordered", unitPrice: 10, quantity: 1 },
    { status: "ready", unitPrice: 5, quantity: 2 },
    { status: "delivered", unitPrice: 7, quantity: 1 },
    { status: "cancelled", unitPrice: 99, quantity: 1 },
  ],
};

describe("orderItemCounts", () => {
  it("conta linhas por estado", () => {
    expect(orderItemCounts(order)).toEqual({ ordered: 2, ready: 1, delivered: 1, cancelled: 1 });
  });

  it("tolera comanda sem itens", () => {
    expect(orderItemCounts({})).toEqual({ ordered: 0, ready: 0, delivered: 0, cancelled: 0 });
    expect(orderItemCounts(null)).toEqual({ ordered: 0, ready: 0, delivered: 0, cancelled: 0 });
  });
});

describe("orderTotal / pendingItems", () => {
  it("ignora itens cancelados no total", () => {
    expect(orderTotal(order)).toBe(10 + 10 + 5 * 2 + 7);
  });

  it("pendentes excluem entregues e cancelados", () => {
    expect(pendingItems(order)).toHaveLength(3);
  });
});
