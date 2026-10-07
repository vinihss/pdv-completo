// Novo (não existe teste equivalente no web; o módulo é 1:1 do
// frontend/src/entities/order/model/order.js). Cobre o que a tela do garçom
// (Frente 2) vai ler: identificação, total e o corte entregue/pendente.
import { orderAllDelivered, orderHasReady, orderLabel, orderTotal, pendingItems } from "./order.js";

function item(status, { unitPrice = 10, quantity = 1 } = {}) {
  return { status, unitPrice, quantity };
}

describe("orderLabel", () => {
  it("mesa com número e mesa sem número", () => {
    expect(orderLabel({ tableId: "t1", tableNumber: 7 })).toBe("Mesa 7");
    expect(orderLabel({ tableId: "t1" })).toBe("Mesa");
  });

  it("balcão/entrega usa o nome do cliente ou o tab (quando não vier nome)", () => {
    expect(orderLabel({ customerName: "João" })).toBe("João");
    expect(orderLabel({ tabLabel: "Balcão 3" })).toBe("Balcão 3");
    expect(orderLabel({ customerName: null, tabLabel: "Balcão 3" })).toBe("Balcão 3");
    expect(orderLabel({})).toBe("—");
  });
});

describe("orderTotal", () => {
  it("soma itens e taxa de entrega, ignorando cancelados", () => {
    const order = {
      items: [item("pending", { unitPrice: 10, quantity: 2 }), item("cancelled", { unitPrice: 99, quantity: 1 })],
      deliveryFee: 5,
    };
    expect(orderTotal(order)).toBe(25);
  });
});

describe("orderHasReady / orderAllDelivered", () => {
  it("detecta item pronto e todos entregues", () => {
    expect(orderHasReady({ items: [item("ready")] })).toBe(true);
    expect(orderHasReady({ items: [item("pending"), item("ready")] })).toBe(true);
    expect(orderHasReady({ items: [item("pending")] })).toBe(false);
  });

  it("lista vazia não é 'todos entregues'", () => {
    expect(orderAllDelivered({ items: [] })).toBe(false);
    expect(orderAllDelivered({ items: [item("delivered"), item("delivered")] })).toBe(true);
  });
});

describe("pendingItems", () => {
  it("só o que ainda não foi entregue/cancelado", () => {
    const items = [item("pending"), item("ready"), item("delivered"), item("cancelled")];
    expect(pendingItems({ items }).map((i) => i.status)).toEqual(["pending", "ready"]);
  });
});