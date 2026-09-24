import { request } from "./http.js";
import { newCorrelationId } from "../lib/uuid.js";

export function getCurrentCashDrawer() {
  return request("GET", "/cash-drawer/current");
}

export function listCashDrawers(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/cash-drawer${qs ? `?${qs}` : ""}`);
}

export function getCashDrawerDetail(id) {
  return request("GET", `/cash-drawer/${id}`);
}

export function openCashDrawer(body) {
  return request("POST", "/cash-drawer/open", { correlationId: newCorrelationId(), ...body });
}

export function registerCashMovement(type, body) {
  return request("POST", `/cash-drawer/${type}`, { correlationId: newCorrelationId(), ...body });
}

export function closeCashDrawer(countedAmount) {
  return request("POST", "/cash-drawer/close", { correlationId: newCorrelationId(), countedAmount });
}