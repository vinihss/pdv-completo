import { toDate } from "@/shared/lib/format";

export function groupDeliveries(list) {
  const safe = Array.isArray(list) ? list.filter(Boolean) : [];
  return {
    active: oldestFirst(
      safe.filter((d) => d.status === "out_for_delivery"),
      (d) => d.dispatchedAt ?? d.createdAt
    ),
    queue: oldestFirst(
      safe.filter((d) => d.status === "awaiting_courier"),
      (d) => d.createdAt
    ),
    failed: newestFirst(
      safe.filter((d) => d.status === "failed"),
      (d) => d.createdAt
    ),
  };
}

function timeOf(delivery, pick) {
  const raw = pick?.(delivery);
  const d = raw ? toDate(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
}

function oldestFirst(items, pick) {
  return [...items].sort((a, b) => timeOf(a, pick) - timeOf(b, pick));
}

function newestFirst(items, pick) {
  return [...items].sort((a, b) => timeOf(b, pick) - timeOf(a, pick));
}
