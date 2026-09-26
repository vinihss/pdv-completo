import { request } from "@/shared/api/http";

export function listCategories() {
  return request("GET", "/categories");
}

export function createCategory(body) {
  return request("POST", "/categories", body);
}

export function updateCategory(id, body) {
  return request("PATCH", `/categories/${id}`, body);
}

export function deleteCategory(id) {
  return request("DELETE", `/categories/${id}`);
}
