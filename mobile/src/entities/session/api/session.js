// Copiado de frontend/src/entities/session/api/session.js (1:1).
import { request } from "@/shared/api/http";

export function listLoginUsers() {
  return request("GET", "/auth/users");
}

// `deviceId` opcional (docs/21 §5.3): com ele o backend valida o vínculo
// aparelho→usuário; sem ele o login antigo (tablet compartilhado/PWA) segue.
export function login(userId, pin, deviceId) {
  const body = { userId, pin };
  if (deviceId) body.deviceId = deviceId;
  return request("POST", "/auth/login", body);
}