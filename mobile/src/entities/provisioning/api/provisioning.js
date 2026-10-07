// Chamadas de provisionamento sobre o `request()` de `shared/api/http`.
// São PÚBLICAS (sem Bearer): o exchange se prova pelo código da chave e o
// refresh pelo device token (`docs/21-device-provisioning.md` §6). O `request`
// só manda Bearer quando há token — inofensivo aqui.
import { Platform } from "react-native";
import * as Device from "expo-device";
import { request } from "@/shared/api/http";

/** Plataforma no formato do contrato: "android" | "ios" (§6). */
export function currentPlatform() {
  return Platform.OS === "ios" ? "ios" : "android";
}

/**
 * Rótulo do aparelho para o gerente reconhecer na lista (`docs/21 §4`, coluna
 * `label`): modelo comercial, caindo para o nome do dispositivo e, por fim,
 * para um texto fixo — nunca manda nulo.
 */
export function currentDeviceLabel() {
  return Device.modelName || Device.deviceName || "Dispositivo";
}

/**
 * `POST /public/provisioning/exchange` → `{deviceId, deviceToken, user}`.
 * Público + rate limit 5/min/IP (`backend/src/http/routes/provisioning.routes.ts`).
 */
export function exchangeProvisioningCode({ code, platform, appProfile, deviceLabel }) {
  return request("POST", "/public/provisioning/exchange", {
    code,
    platform,
    appProfile,
    deviceLabel: deviceLabel ?? null,
  });
}

/**
 * `POST /auth/device/refresh` → `{token, deviceToken, user}`. O deviceToken
 * ROTACIONA a cada chamada — quem chama precisa persistir o novo (§5.3/§11).
 */
export function refreshDeviceSession({ deviceId, deviceToken }) {
  return request("POST", "/auth/device/refresh", { deviceId, deviceToken });
}
