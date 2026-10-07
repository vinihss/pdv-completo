// Código de provisionamento — normalização, máscara de digitação e leitura do
// QR. Espelha o lado do backend (`backend/src/application/provisioning/
// provisioning.usecases.ts`): o código canônico é `PDV` + 16 chars base32, sem
// hífen, e quem normaliza seus erros é o exchange (`docs/21-device-provisioning.md`
// §5.1/§6). O QR carrega `PDVPROV1:<código formatado>` (§5.1) — o prefixo é só
// envelope e cai fora antes de ir para a rede.
//
// O backend RE-normaliza, mas normalizamos antes de enviar por dois motivos:
// (1) o operador pode digitar em minúsculas ou com hífens, (2) evita gastar uma
// das 5 tentativas/min do rate limit do exchange (`docs/21 §11`).

const PREFIX = "PDV";
const BODY_LENGTH = 16;
const GROUP = 4;
const QR_PREFIX = "PDVPROV1:";

/**
 * Forma canônica que o backend hasheia: caixa alta + só alfanumérico
 * (`pdv-abcd-…` → `PDVABCD…`). Mesma regra de `normalizeProvisioningCode` do
 * backend, propositalmente.
 */
export function normalizeProvisioningCode(raw) {
  return String(raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Os 16 chars que o operador digita, sem o `PDV` de prefixo (que é fixo na
 * apresentação). Aceita tanto o corpo cru ("ABCDEF…") quanto o código inteiro
 * ("PDV-ABCD…"): se vier com o prefixo, ele é removido.
 */
export function provisioningCodeBody(raw) {
  const canonical = normalizeProvisioningCode(raw);
  const body = canonical.startsWith(PREFIX) ? canonical.slice(PREFIX.length) : canonical;
  return body.slice(0, BODY_LENGTH);
}

/**
 * `PDV` + corpo. É o valor que vai no body do exchange; o `PDV` entra aqui
 * porque o campo de digitação só carrega o corpo.
 */
export function canonicalProvisioningCode(raw) {
  return `${PREFIX}${provisioningCodeBody(raw)}`;
}

/**
 * Valor do `TextInput` de digitação: grupos de 4 separados por hífen
 * ("ABCD-EFGH-IJKL-MNOP"). Sem hífen no fim para o cursor não "pular".
 */
export function maskProvisioningCodeInput(raw) {
  const body = provisioningCodeBody(raw);
  return body.replace(new RegExp(`(.{${GROUP}})(?=.)`, "g"), "$1-");
}

/**
 * Exibição completa com prefixo ("PDV-ABCD-EFGH-IJKL-MNOP"), usada como
 * placeholder/preview. Sem corpo devolve só `PDV`.
 */
export function formatProvisioningCode(raw) {
  const body = provisioningCodeBody(raw);
  const groups = body.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? [];
  return [PREFIX, ...groups].join("-");
}

/**
 * Lê o payload do QR e devolve o código canônico, tirando o envelope
 * `PDVPROV1:`. QR de outro produto volta normalizado (o exchange recusa com
 * `provisioning_key_invalid`) — quem chama decide se valida o formato.
 */
export function parseQrPayload(payload) {
  const raw = String(payload ?? "").trim();
  return normalizeProvisioningCode(raw.replace(new RegExp(`^${QR_PREFIX}`, "i"), ""));
}
