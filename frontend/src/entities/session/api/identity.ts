import { request } from "@/shared/api/http";

// Identidade centralizada (docs/26 §4 — contrato CONGELADO). Estas rotas são
// a etapa de conta global (e-mail + senha): o `accountToken` delas vale só
// para `password/change` e `select-tenant`, e nunca deve ser confundido com
// o token de tenant que a sessão do app consome. Todas usam
// `skipUnauthorized`: um 401 aqui é resposta do fluxo (senha errada, token de
// conta expirado), não um "a sessão de tenant morreu".
//
// Os endpoints antigos (`login` PIN, `listLoginUsers`) continuam em
// `api/session.ts` — são a rota fallback `/login/pin` (docs/26 §2, decisão 5).

/** POST /auth/session → { accountToken, mustChangePassword, companies }. 401 = credencial genérica. */
export function sessionStart(email, password) {
  return request("POST", "/auth/session", { email, password }, { skipUnauthorized: true });
}

/** POST /auth/password/change — Bearer accountToken. Troca obrigatória do primeiro login (docs/26 §2, decisão 8). */
export function changePassword(accountToken, newPassword) {
  return request(
    "POST",
    "/auth/password/change",
    { newPassword },
    { token: accountToken, skipUnauthorized: true }
  );
}

/** POST /auth/select-tenant — Bearer accountToken. 403 tenant_not_linked = vínculo revogado entre o login e a escolha. */
export function selectTenant(accountToken, slug) {
  return request("POST", "/auth/select-tenant", { slug }, { token: accountToken, skipUnauthorized: true });
}

/** POST /auth/refresh — rotação: a resposta traz um refreshToken novo; reuso revoga a família (docs/26 §2, decisão 2). */
export function refreshSession(refreshToken) {
  return request("POST", "/auth/refresh", { refreshToken }, { skipUnauthorized: true });
}

/** POST /auth/logout — idempotente; no app é fire-and-forget no botão de sair. */
export function logoutSession(refreshToken) {
  return request("POST", "/auth/logout", { refreshToken }, { skipUnauthorized: true });
}

/**
 * POST /auth/password/forgot — responde 202 sempre (não enumera contas).
 * Sem SMTP o backend devolve 503 email_not_configured; o tratamento da
 * mensagem amigável é da tela, este módulo só repassa o erro.
 */
export function forgotPassword(email) {
  return request("POST", "/auth/password/forgot", { email }, { skipUnauthorized: true });
}

/** POST /auth/password/reset — 400 se o token for inválido, expirado ou já usado. */
export function resetPassword(token, newPassword) {
  return request("POST", "/auth/password/reset", { token, newPassword }, { skipUnauthorized: true });
}
