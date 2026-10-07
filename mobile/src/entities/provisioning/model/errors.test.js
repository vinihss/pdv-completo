// Mapeamento erro→mensagem PT-BR. Códigos do catálogo do backend
// (`backend/src/domain/errors.ts`, bloco "Device provisioning") e critérios
// 5/6 do `docs/21-device-provisioning.md` §12 (revogação apaga a credencial).
import {
  isCredentialInvalidError,
  loginErrorMessage,
  provisioningErrorMessage,
} from "./errors.js";

describe("provisioningErrorMessage", () => {
  it.each([
    ["provisioning_key_invalid", "Chave inválida. Confira o código e tente de novo."],
    ["provisioning_key_expired", "Esta chave expirou. Peça uma nova ao gerente."],
    ["provisioning_key_revoked", "Esta chave foi revogada. Peça uma nova ao gerente."],
  ])("mapeia %s", (code, expected) => {
    expect(provisioningErrorMessage({ code })).toBe(expected);
  });

  it("cai no genérico de servidor para erro de rede (sem code)", () => {
    expect(provisioningErrorMessage(new TypeError("Network request failed"))).toContain(
      "Servidor indisponível",
    );
  });

  it("cai no genérico para status 429 sem code", () => {
    expect(provisioningErrorMessage({ status: 429 })).toBe(
      "Muitas tentativas. Aguarde um minuto.",
    );
  });
});

describe("loginErrorMessage", () => {
  it("mapeia invalid_credentials e too_many_attempts", () => {
    expect(loginErrorMessage({ code: "invalid_credentials" })).toBe("PIN incorreto. Tente novamente.");
    expect(loginErrorMessage({ code: "too_many_attempts" })).toBe(
      "Muitas tentativas. Aguarde um minuto.",
    );
  });

  it("devolve PIN incorreto como padrão", () => {
    expect(loginErrorMessage(new Error("boom"))).toBe("PIN incorreto. Tente novamente.");
  });
});

describe("isCredentialInvalidError", () => {
  it("aceita os três códigos que matam a credencial", () => {
    expect(isCredentialInvalidError({ code: "device_revoked" })).toBe(true);
    expect(isCredentialInvalidError({ code: "device_unknown" })).toBe(true);
    expect(isCredentialInvalidError({ code: "device_not_provisioned" })).toBe(true);
  });

  it("recusa chave inválida (problema do código, não do aparelho)", () => {
    expect(isCredentialInvalidError({ code: "provisioning_key_invalid" })).toBe(false);
    expect(isCredentialInvalidError(null)).toBe(false);
  });
});
