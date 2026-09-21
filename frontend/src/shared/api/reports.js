import { request } from "./http.js";

export function salesReport(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/reports/sales${qs ? `?${qs}` : ""}`);
}

export function auditLog(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/audit-log${qs ? `?${qs}` : ""}`);
}