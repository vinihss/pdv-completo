import { request } from "@/shared/api/http";

export function auditLog(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/audit-log${qs ? `?${qs}` : ""}`);
}
