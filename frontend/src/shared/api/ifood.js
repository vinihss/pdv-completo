import { request } from "./http.js";

export function getIfoodStatus() {
  return request("GET", "/ifood/status");
}

export function syncIfoodCatalog() {
  return request("POST", "/ifood/catalog-sync");
}