import { request } from "@/shared/api/http";

// Estações de produção (grupos de cozinha): "Pratos", "Bebidas"...
export function listKitchenGroups() {
  return request("GET", "/kitchen-groups");
}

export function createKitchenGroup(body) {
  return request("POST", "/kitchen-groups", body);
}

export function updateKitchenGroup(id, body) {
  return request("PATCH", `/kitchen-groups/${id}`, body);
}

export function deleteKitchenGroup(id) {
  return request("DELETE", `/kitchen-groups/${id}`);
}
