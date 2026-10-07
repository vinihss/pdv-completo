// Contrato do código de provisionamento. Espelha
// `backend/src/application/provisioning/provisioning.usecases.ts`
// (`normalizeProvisioningCode`/`formatProvisioningCode`) e o envelope do QR
// definido em `docs/21-device-provisioning.md` §5.1.
import {
  canonicalProvisioningCode,
  formatProvisioningCode,
  maskProvisioningCodeInput,
  normalizeProvisioningCode,
  parseQrPayload,
  provisioningCodeBody,
} from "./code.js";

describe("normalizeProvisioningCode", () => {
  it("deixa caixa alta e remove tudo que não é alfanumérico", () => {
    expect(normalizeProvisioningCode("pdv-abcd-efgh-ijkl-mnop")).toBe("PDVABCDEFGHIJKLMNOP");
    expect(normalizeProvisioningCode(" pdv abcd efgh ")).toBe("PDVABCDEFGH");
    expect(normalizeProvisioningCode(null)).toBe("");
  });
});

describe("provisioningCodeBody", () => {
  it("tira o prefixo PDV e limita a 16 caracteres", () => {
    expect(provisioningCodeBody("PDV-ABCD-EFGH-IJKL-MNOP")).toBe("ABCDEFGHIJKLMNOP");
    expect(provisioningCodeBody("abcdefghijklmnop")).toBe("ABCDEFGHIJKLMNOP");
    expect(provisioningCodeBody("ABCDEFGHIJKLMNOPZZZZ")).toBe("ABCDEFGHIJKLMNOP");
  });
});

describe("canonicalProvisioningCode", () => {
  it("devolve PDV + corpo, aceitando digitação parcial ou completa", () => {
    expect(canonicalProvisioningCode("abcd-efgh-ijkl-mnop")).toBe("PDVABCDEFGHIJKLMNOP");
    expect(canonicalProvisioningCode("PDVABCDEFGHIJKLMNOP")).toBe("PDVABCDEFGHIJKLMNOP");
    expect(canonicalProvisioningCode("ABCD")).toBe("PDVABCD");
  });
});

describe("maskProvisioningCodeInput", () => {
  it("agrupa o corpo de 4 em 4 sem hífen no fim", () => {
    expect(maskProvisioningCodeInput("A")).toBe("A");
    expect(maskProvisioningCodeInput("ABCD")).toBe("ABCD");
    expect(maskProvisioningCodeInput("ABCDE")).toBe("ABCD-E");
    expect(maskProvisioningCodeInput("ABCDEFGHIJKLMNOP")).toBe("ABCD-EFGH-IJKL-MNOP");
    // Colar o código completo formata igual a digitar.
    expect(maskProvisioningCodeInput("PDV-ABCD-EFGH-IJKL-MNOP")).toBe("ABCD-EFGH-IJKL-MNOP");
  });
});

describe("formatProvisioningCode", () => {
  it("reconstrói a máscara de exibição", () => {
    expect(formatProvisioningCode("ABCD")).toBe("PDV-ABCD");
    expect(formatProvisioningCode("ABCDEFGHIJKLMNOP")).toBe("PDV-ABCD-EFGH-IJKL-MNOP");
    expect(formatProvisioningCode("")).toBe("PDV");
  });
});

describe("parseQrPayload", () => {
  it("remove o envelope PDVPROV1: e normaliza", () => {
    expect(parseQrPayload("PDVPROV1:PDV-ABCD-EFGH-IJKL-MNOP")).toBe("PDVABCDEFGHIJKLMNOP");
    expect(parseQrPayload("pdvprov1:pdvabcdefghijklmnop")).toBe("PDVABCDEFGHIJKLMNOP");
  });

  it("aceita payload sem prefixo (QR já cru)", () => {
    expect(parseQrPayload("PDVABCDEFGHIJKLMNOP")).toBe("PDVABCDEFGHIJKLMNOP");
  });
});
