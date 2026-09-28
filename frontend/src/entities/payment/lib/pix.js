// BR Code (payload EMV do Pix) — ver 01-backend-spec.md §12.
// Geração 100% client-side: a chave Pix é pública por natureza, não há segredo.
//
// O padrão EMV/BACEN trata o payload como bytes UTF-8: os campos TLV (ID +
// tamanho + valor) declaram o tamanho EM BYTES, e o CRC-16 é calculado sobre
// os bytes UTF-8. Usar comprimento JS (UTF-16) quebra o payload quando há
// acentos (ex: cidade "São Leopoldo"), então tudo aqui é byte-based.

const encoder = new TextEncoder();

// TLV do EMV: 2 dígitos de ID + 2 dígitos de tamanho. O formato curto cobre
// 0–99 bytes; acima disso o comprimento ganharia um terceiro dígito e a
// leitura do payload inteiro quebraria (ver `orcamentoDescricao`).
const MAX_TLV_BYTES = 99;

// Limite da descrição (sub-campo 26.02) no padrão BR Code.
const DESC_MAX_BYTES = 40;

// A GUI do Pix é definida em minúsculas no padrão do BACEN — o leitor
// reconhece o payload pelo prefixo "0014br.gov.bcb.pix". Não usar maiúsculas.
const GUI = "br.gov.bcb.pix";

// Reduz a ASCII imprimível: remove diacríticos ("São" → "Sao") e qualquer
// caractere fora de U+0020–U+007E. Sem o segundo passo sobraria o travessão
// do rótulo de comanda sem mesa, que é 3 bytes UTF-8 e reprova em leitores
// estritos.
function ascii(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

function utf8Length(value) {
  return encoder.encode(value).length;
}

function truncateBytes(value, max) {
  const bytes = encoder.encode(value);
  if (bytes.length <= max) return value;
  return new TextDecoder().decode(bytes.slice(0, max)).replace(/\uFFFD/g, "");
}

function field(id, value) {
  const length = utf8Length(value);
  if (length > MAX_TLV_BYTES) {
    throw new Error(`campo ${id} do BR Code excede ${MAX_TLV_BYTES} bytes (${length})`);
  }
  return `${id}${String(length).padStart(2, "0")}${value}`;
}

function crc16(payload) {
  const bytes = encoder.encode(payload);
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

// ---------------------------------------------------------------------------
// Chave Pix
//
// O tipo da chave é deduzido do próprio formato, e não do
// `store_settings.pixKeyType`: CPF tem 11 dígitos, CNPJ 14, e-mail tem "@",
// telefone em E.164 começa com "+" e a aleatória (EVP) é um UUID. O BACEN
// aceita a chave exatamente no formato canônico, então a entrada é
// canonicalizada aqui — assim a chave salva com máscara
// ("519.914.324-85", "+55 (51) 99143-2485") ainda gera um BR Code válido.
// ---------------------------------------------------------------------------

const E_MAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const EVP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SO_DIGITOS = /^\d+$/;

function digitoVerificador(base, pesos) {
  const soma = [...base].reduce((acc, digito, i) => acc + Number(digito) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function validarCpf(cpf) {
  if (!/^\d{11}$/.test(cpf)) return false;
  const base = cpf.slice(0, 9);
  const d1 = digitoVerificador(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoVerificador(base + d1, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return Number(cpf[9]) === d1 && Number(cpf[10]) === d2;
}

export function validarCnpj(cnpj) {
  if (!/^\d{14}$/.test(cnpj)) return false;
  const base = cnpj.slice(0, 12);
  const d1 = digitoVerificador(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoVerificador(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return Number(cnpj[12]) === d1 && Number(cnpj[13]) === d2;
}

// O dígito verificador é aviso, nunca classificador: um CPF digitado errado
// que caísse no ramo "telefone" viraria uma chave válida de outra pessoa, e o
// cliente pagaria para o número errado. Preferimos recusar com aviso.
export function analyzePixKey(raw) {
  const value = String(raw ?? "").trim();
  const warnings = [];

  if (!value) return { key: "", type: null, warnings: ["Chave Pix não configurada."] };

  if (value.includes("@")) {
    const key = value.toLowerCase().replace(/\s+/g, "");
    if (!E_MAIL.test(key)) warnings.push("A chave Pix de e-mail não parece um endereço válido.");
    return { key, type: "email", warnings };
  }

  if (EVP.test(value)) return { key: value.toLowerCase(), type: "random", warnings };

  if (value.startsWith("+")) {
    const key = `+${value.replace(/\D/g, "")}`;
    if (key.length < 3 || key.length > 15) warnings.push("A chave Pix de telefone está fora do formato E.164.");
    return { key, type: "phone", warnings };
  }

  // máscaras de CPF ("509.876.543-21") e CNPJ ("11.222.333/0001-81")
  if (/[^\d\s.()/-]/.test(value)) {
    return { key: value, type: null, warnings: ["A chave Pix tem letras ou caracteres inválidos."] };
  }

  const digits = value.replace(/\D/g, "");

  // 11 dígitos é ambíguo: CPF (509.876.543-21) e celular no formato nacional
  // (51 99143-2485) têm exatamente o mesmo formato. O padrão é tratar como
  // CPF — quem quiser telefone digita o "+55" e cai no caso de cima.
  if (digits.length === 11) {
    if (!validarCpf(digits)) {
      warnings.push("Os dígitos verificadores do CPF não conferem — confira a chave Pix antes de cobrar.");
    }
    return { key: digits, type: "cpf", warnings };
  }

  if (digits.length === 14) {
    if (!validarCnpj(digits)) {
      warnings.push("Os dígitos verificadores do CNPJ não conferem — confira a chave Pix antes de cobrar.");
    }
    return { key: digits, type: "cnpj", warnings };
  }

  if (SO_DIGITOS.test(digits) && (digits.length === 10 || (digits.length >= 12 && digits.startsWith("55")))) {
    return { key: digits.length === 10 ? `+55${digits}` : `+${digits}`, type: "phone", warnings };
  }

  return { key: digits, type: null, warnings: ["Não foi possível identificar o tipo da chave Pix."] };
}

// O BACEN exige txid de 1 a 25 caracteres ALFANUMÉRICOS. A `order.id` é um
// `crypto.randomUUID()`, ou seja, 36 caracteres com hífens — que reprova na
// validação de padrão do txid. Removemos o que não for alfanumérico e
// cortamos em 25 (os 25 primeiros hex de um UUIDv4 são ~100 bits, colisão
// desprezível). Vazio vira o "***" que o próprio padrão define.
function projectTxid(value) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 25);
}

// O campo 54 é opcional: vazio significa "qualquer valor" e o leitor deixa o
// pagador digitar. Emitir "0.00" ou "NaN" travaria a cobrança.
function formatAmount(amount) {
  if (amount === null || amount === undefined || amount === "") return null;
  const valor = Number(amount);
  if (!Number.isFinite(valor)) return null;
  return valor.toFixed(2);
}

export function buildPixPayload({ pixKey, merchantName, merchantCity, amount, txid, description }) {
  const { key } = analyzePixKey(pixKey);
  const gui = field("00", GUI);

  // 26 = "26" + GUI + "01" + chave + ["02" + descrição]. A descrição só pode
  // ocupar o que sobrar dos 99 bytes: com uma chave de e-mail ou EVP (36+
  // bytes) uma descrição cheia de 40 estouraria o campo e o cabeçalho de
  // 2 dígitos viraria "26105...", corrompendo o payload inteiro.
  const orcamento = MAX_TLV_BYTES - utf8Length(gui) - 4 - utf8Length(key) - 4;
  if (orcamento < 0) throw new Error("A chave Pix é longa demais para o campo 26 do BR Code.");

  const descricao = description ? truncateBytes(ascii(description), Math.min(DESC_MAX_BYTES, orcamento)) : "";
  const merchantAccountInfo = gui + field("01", key) + (descricao ? field("02", descricao) : "");
  const valor = formatAmount(amount);

  const payloadWithoutCRC =
    field("00", "01") +
    field("26", merchantAccountInfo) +
    field("52", "0000") +
    field("53", "986") +
    (valor ? field("54", valor) : "") +
    field("58", "BR") +
    field("59", truncateBytes(ascii(merchantName), 25)) +
    field("60", truncateBytes(ascii(merchantCity), 15)) +
    field("62", field("05", projectTxid(txid) || "***")) +
    "6304";

  return payloadWithoutCRC + crc16(payloadWithoutCRC);
}
