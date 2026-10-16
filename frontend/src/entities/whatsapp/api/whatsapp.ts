import { request } from "@/shared/api/http";

/**
 * API do WhatsApp (painel do gerente). Espelha `whatsapp.routes.ts` — todas
 * as rotas são manager-only, então não há token de cliente aqui.
 */

export function getWhatsAppStatus() {
  return request("GET", "/whatsapp/status");
}

/**
 * O que o browser precisa para chamar FB.login: app id e config id do
 * Embedded Signup. São valores públicos (o segredo é o app_secret, que nunca
 * sai do backend).
 */
export function getWhatsAppSignupConfig() {
  return request("GET", "/whatsapp/config");
}

/**
 * Fecha o onboarding no servidor: troca o code, valida os escopos, registra o
 * número na Cloud API e assina os webhooks da WABA.
 *
 * O `code` tem TTL de 30 segundos e é de uso único — se der erro de
 * `whatsapp_invalid_code`, o gerente precisa refazer o fluxo inteiro, não
 * reenviar este request.
 */
export function exchangeEmbeddedSignup(payload) {
  return request("POST", "/whatsapp/embedded-signup/exchange", payload);
}

export function disconnectWhatsApp() {
  return request("POST", "/whatsapp/disconnect");
}

/** Histórico das mensagens enviadas, com o status que a Meta reportou. */
export function getWhatsAppMessages(limit = 50) {
  return request("GET", `/whatsapp/messages?limit=${limit}`);
}
