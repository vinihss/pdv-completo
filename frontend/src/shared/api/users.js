import { request } from "./http.js";

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