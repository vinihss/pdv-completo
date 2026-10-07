import { groupDeliveries } from "./deliveries";

describe("groupDeliveries", () => {
  test("agrupa por status e ordena conforme esperado", () => {
    const list = [
      { id: "d3", status: "awaiting_courier", createdAt: "2026-10-06T10:10:00Z" },
      { id: "d1", status: "out_for_delivery", dispatchedAt: "2026-10-06T10:05:00Z", createdAt: "2026-10-06T10:00:00Z" },
      { id: "d2", status: "out_for_delivery", dispatchedAt: "2026-10-06T10:08:00Z", createdAt: "2026-10-06T09:50:00Z" },
      { id: "f1", status: "failed", createdAt: "2026-10-06T09:40:00Z" },
      { id: "f2", status: "failed", createdAt: "2026-10-06T10:20:00Z" },
    ];

    const grouped = groupDeliveries(list);
    expect(grouped.active.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(grouped.queue.map((d) => d.id)).toEqual(["d3"]);
    expect(grouped.failed.map((d) => d.id)).toEqual(["f2", "f1"]);
  });

  test("filtra inválidos", () => {
    const grouped = groupDeliveries([null, undefined, { id: "q", status: "awaiting_courier", createdAt: "2026-10-06T10:00:00Z" }]);
    expect(grouped.queue.length).toBe(1);
    expect(grouped.active.length).toBe(0);
    expect(grouped.failed.length).toBe(0);
  });
});
