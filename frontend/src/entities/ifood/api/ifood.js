import { request } from "@/shared/api/http";

export function getIfoodStatus() {
  return request("GET", "/ifood/status");
}

export function syncIfoodCatalog() {
  return request("POST", "/ifood/catalog-sync");
}