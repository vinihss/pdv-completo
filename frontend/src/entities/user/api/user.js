import { request, upload } from "@/shared/api/http";

export function listUsers() {
  return request("GET", "/users");
}

export function createUser(body) {
  return request("POST", "/users", body);
}

export function updateUser(id, body) {
  return request("PATCH", `/users/${id}`, body);
}

export function resetPin(id) {
  return request("PATCH", `/users/${id}/reset-pin`);
}

export function uploadUserPhoto(id, file) {
  return upload(`/users/${id}/photo`, "photo", file);
}

export function removeUserPhoto(id) {
  return request("DELETE", `/users/${id}/photo`);
}
