import { request } from "@/shared/api/http";

export function salesReport(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/reports/sales${qs ? `?${qs}` : ""}`);
}
