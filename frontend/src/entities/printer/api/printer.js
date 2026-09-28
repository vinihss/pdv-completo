import { request } from "@/shared/api/http";

export function printOrder(orderId, destination) {
  return request("POST", `/orders/${orderId}/print`, { destination });
}

export function getPrintStatus(orderId) {
  return request("GET", `/orders/${orderId}/print-status`);
}

export function getPrinterStatus(destination) {
  return request("GET", `/printers/status${destination ? `?destination=${destination}` : ""}`);
}

export function getPrinterHealth() {
  return request("GET", "/printers/health");
}
