// Copiado de frontend/src/entities/store/api/store.js (1:1).
import { request, upload } from "@/shared/api/http";

export function getStoreInfo() {
  return request("GET", "/store-info");
}

export function getStoreSettings() {
  return request("GET", "/store-settings");
}

export function updateStoreSettings(body) {
  return request("PUT", "/store-settings", body);
}

export function uploadStoreLogo(file) {
  return upload("/store-settings/logo", "logo", file);
}

export function removeStoreLogo() {
  return request("DELETE", "/store-settings/logo");
}