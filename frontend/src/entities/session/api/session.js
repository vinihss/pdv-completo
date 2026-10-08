import { request } from "@/shared/api/http";

export function listLoginUsers() {
  return request("GET", "/auth/users");
}

export function login(userId, pin) {
  return request("POST", "/auth/login", { userId, pin });
}

/**
 * Autoatualização do perfil do usuário logado (rota vem do token, não do body).
 * Só aceita name/phone/email — role/pin/active ficam com o manager em /users/:id.
 */
export function updateMe(body) {
  return request("PATCH", "/auth/me", body);
}

/**
 * Perfil fresco do usuário logado. O login devolve só {id,name,role,photoPath},
 * então a tela de perfil lê phone/email daqui antes de editar — sem isso um
 * "salvar" com campo vazio apagaria dado existente no banco.
 */
export function getMe() {
  return request("GET", "/auth/me");
}

/** Upload de foto do próprio usuário (multipart). */
export function uploadUserMePhoto(file) {
  const form = new FormData();
  form.append("photo", file);
  return request("POST", "/auth/me/photo", form);
}

/** Remove a foto do próprio usuário. */
export function removeUserMePhoto() {
  return request("DELETE", "/auth/me/photo");
}