import { request } from "./http.js";

export function listLoginUsers() {
  return request("GET", "/auth/users");
}

export function login(userId, pin) {
  return request("POST", "/auth/login", { userId, pin });
}