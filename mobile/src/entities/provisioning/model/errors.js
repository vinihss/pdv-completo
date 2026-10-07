// Vocabulário PT-BR dos erros do provisioning. Os códigos são os do catálogo
// do backend (`backend/src/domain/errors.ts`, bloco "Device provisioning") e o
// `request` de `shared/api/http` já os entrega em `error.code`. A tela nunca
// mostra a mensagem crua do servidor: o produto é PT-BR e a mensagem tem que
// dizer o que fazer.
//
// `docs/21-device-provisioning.md`: exchange (§5.2) devolve
// `provisioning_key_invalid|expired|revoked`; refresh e login com `deviceId`
// (§5.3) devolvem `device_unknown|device_revoked|device_not_provisioned`.

const MESSAGES = {
  provisioning_key_invalid: "Chave inválida. Confira o código e tente de novo.",
  provisioning_key_expired: "Esta chave expirou. Peça uma nova ao gerente.",
  provisioning_key_revoked: "Esta chave foi revogada. Peça uma nova ao gerente.",
  device_unknown: "Este aparelho não está mais vinculado à loja.",
  device_revoked: "Este aparelho foi revogado. Provisione novamente para voltar a usar.",
  device_not_provisioned: "Este aparelho não está vinculado a este usuário.",
  invalid_credentials: "PIN incorreto. Tente novamente.",
  invalid_pin: "PIN incorreto. Tente novamente.",
  too_many_attempts: "Muitas tentativas. Aguarde um minuto.",
};

const SERVER_UNAVAILABLE = "Servidor indisponível. Verifique a rede da loja e tente novamente.";

/** Mensagem PT-BR para um erro vindo do `request` (ou rede). */
export function provisioningErrorMessage(error, fallback = SERVER_UNAVAILABLE) {
  if (!error) return fallback;
  if (error.code && MESSAGES[error.code]) return MESSAGES[error.code];
  if (error.status === 429) return MESSAGES.too_many_attempts;
  return fallback;
}

/** Mensagem PT-BR para o erro de autenticação (login local por PIN). */
export function loginErrorMessage(error) {
  if (error?.code && MESSAGES[error.code]) return MESSAGES[error.code];
  if (error?.status === 429) return MESSAGES.too_many_attempts;
  return "PIN incorreto. Tente novamente.";
}

// Critérios 5/6 do `docs/21 §12`: aparelho revogado/desconhecido ou vínculo
// perdido significa que a credencial local morreu — a tela de provisionamento
// volta. O AuthProvider usa isto para limpar o SecureStore.
const CREDENTIAL_INVALID_CODES = ["device_revoked", "device_unknown", "device_not_provisioned"];

export function isCredentialInvalidError(error) {
  return CREDENTIAL_INVALID_CODES.includes(error?.code);
}
