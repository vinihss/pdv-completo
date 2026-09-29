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
// O tipo vem de `store_settings.pixKeyType` — é o gerente quem diz se a chave
// é telefone ou CPF, e os formatos se cruzam: CPF e celular no formato nacional
// têm exatamente os mesmos 11 dígitos, então deduzir "11 dígitos = CPF"
// transformava o telefone do gerente num QR que o app do banco recusava por
// "CPF inválido". A dedução pelo formato é o plano B, usado só quando o valor
// não cabe no tipo escolhido (e sempre com aviso).
//
// O BACEN aceita a chave exatamente no formato canônico, então a entrada é
// canonicalizada nos dois caminhos — assim a chave salva com máscara
// ("519.914.324-85", "+55 (51) 99143-2485") ainda gera um BR Code válido.
// ---------------------------------------------------------------------------

const E_MAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const EVP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SO_DIGITOS = /^\d+$/;

const TIPOS = ["cpf", "cnpj", "email", "phone", "random"];

// Rótulo em PT-BR do tipo efetivo, para a tela de Configurações mostrar o que
// o BR Code vai realmente conter.
export const PIX_KEY_TYPE_LABELS = {
  cpf: "CPF",
  cnpj: "CNPJ",
  email: "E-mail",
  phone: "Telefone",
  random: "Chave aleatória (EVP)",
};

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

// Telefone tem de sair sempre em E.164. Sem o DDI o app do banco lê a chave
// como documento ("51991432485" vira CPF) e recusa. O Settings aceita a chave
// como o gerente digita, então o input vem nos formatos nacionais, com
// máscara: DDD + fixo (10), DDD + celular (11, o 3º dígito é sempre 9), e os
// mesmos com o 55 do DDI já digitado (12 ou 13).
//
// O dígito 9 é só aviso: a hipótese padrão para 11 dígitos é celular nacional,
// porque o gerente escolheu "telefone" nas configurações e a intenção dele
// manda. O aviso cobre o formato ambíguo sem bloquear a cobrança.
function canonicalizarTelefone(value) {
  const digits = value.replace(/\D/g, "");
  const telefone = (key, avisos) => ({ key, type: "phone", warnings: avisos || [] });

  if (value.startsWith("+")) {
    const key = `+${digits}`;
    return telefone(key, key.length < 3 || key.length > 15
      ? ["A chave Pix de telefone está fora do formato E.164."]
      : []);
  }

  // DDI + DDD + celular (13) ou DDI + DDD + fixo (12).
  if (digits.length >= 12 && digits.startsWith("55")) return telefone(`+${digits}`);

  // DDI + DDD + fixo, sem o 9 do celular (11 começando por 55).
  if (digits.length === 11 && digits.startsWith("55")) return telefone(`+${digits}`);

  // DDD + celular.
  if (digits.length === 11 && digits[2] === "9") return telefone(`+55${digits}`);

  // DDD + fixo.
  if (digits.length === 10) return telefone(`+55${digits}`);

  if (digits.length === 11) {
    return telefone(`+55${digits}`, [
      "A chave Pix de telefone tem 11 dígitos e não começa por 9 — confira se o número já inclui o DDD.",
    ]);
  }

  return null;
}

// Canonicaliza a chave no tipo escolhido pelo gerente. Devolve `null` quando o
// valor não é compatível com o tipo — aí quem decide é a dedução pelo formato.
function canonicalizarPorTipo(value, tipo) {
  if (tipo === "email") {
    if (!value.includes("@")) return null;
    const key = value.toLowerCase().replace(/\s+/g, "");
    return {
      key,
      type: "email",
      warnings: E_MAIL.test(key) ? [] : ["A chave Pix de e-mail não parece um endereço válido."],
    };
  }

  if (tipo === "random") {
    return EVP.test(value) ? { key: value.toLowerCase(), type: "random", warnings: [] } : null;
  }

  // Telefone e documento são feitos de dígitos; letra aqui já é outra coisa.
  if (/[^\d\s.()/+-]/.test(value)) return null;

  if (tipo === "phone") return canonicalizarTelefone(value);

  if (tipo === "cpf" || tipo === "cnpj") {
    const digits = value.replace(/\D/g, "");
    if (digits.length !== (tipo === "cpf" ? 11 : 14)) return null;
    const confere = tipo === "cpf" ? validarCpf(digits) : validarCnpj(digits);
    return {
      key: digits,
      type: tipo,
      warnings: confere
        ? []
        : [`Os dígitos verificadores do ${PIX_KEY_TYPE_LABELS[tipo]} não conferem — confira a chave Pix antes de cobrar.`],
    };
  }

  return null;
}

// Plano B: tipo deduzido pelo próprio formato. Só entra aqui quando não há
// `typeHint` ou quando o valor não cabe nele.
function deduzirTipoPix(value) {
  const avisos = [];
  const resultado = (key, type) => ({ key, type, warnings: avisos });

  if (value.includes("@")) {
    const key = value.toLowerCase().replace(/\s+/g, "");
    if (!E_MAIL.test(key)) avisos.push("A chave Pix de e-mail não parece um endereço válido.");
    return resultado(key, "email");
  }

  if (EVP.test(value)) return { key: value.toLowerCase(), type: "random", warnings: [] };

  if (value.startsWith("+")) return canonicalizarTelefone(value);

  // máscaras de CPF ("509.876.543-21") e CNPJ ("11.222.333/0001-81")
  if (/[^\d\s.()/-]/.test(value)) {
    return { key: value, type: null, warnings: ["A chave Pix tem letras ou caracteres inválidos."] };
  }

  const digits = value.replace(/\D/g, "");

  // 11 dígitos é ambíguo: CPF (509.876.543-21) e celular no formato nacional
  // (51 99143-2485) têm exatamente o mesmo formato. Sem `pixKeyType` não há como
  // desempatar, e o padrão é tratar como CPF.
  if (digits.length === 11) {
    if (!validarCpf(digits)) {
      avisos.push("Os dígitos verificadores do CPF não conferem — confira a chave Pix antes de cobrar.");
    }
    return resultado(digits, "cpf");
  }

  if (digits.length === 14) {
    if (!validarCnpj(digits)) {
      avisos.push("Os dígitos verificadores do CNPJ não conferem — confira a chave Pix antes de cobrar.");
    }
    return resultado(digits, "cnpj");
  }

  if (SO_DIGITOS.test(digits) && (digits.length === 10 || (digits.length >= 12 && digits.startsWith("55")))) {
    return canonicalizarTelefone(value);
  }

  avisos.push("Não foi possível identificar o tipo da chave Pix.");
  return resultado(digits, null);
}

export function analyzePixKey(raw, typeHint) {
  const value = String(raw ?? "").trim();
  const tipo = TIPOS.includes(typeHint) ? typeHint : null;

  if (!value) return { key: "", type: null, warnings: ["Chave Pix não configurada."] };

  if (tipo) {
    const escolhida = canonicalizarPorTipo(value, tipo);
    if (escolhida) return escolhida;
  }

  const deduzida = deduzirTipoPix(value);
  if (!tipo) return deduzida;

  // O tipo das configurações não serviu para o valor. O gerente precisa saber,
  // porque salvou um tipo que não bate com o que digitou.
  return {
    ...deduzida,
    warnings: [
      `A chave Pix não é do tipo "${PIX_KEY_TYPE_LABELS[tipo]}" escolhido nas configurações — usando o tipo deduzido pelo formato.`,
      ...deduzida.warnings,
    ],
  };
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

export function buildPixPayload({ pixKey, pixKeyType, merchantName, merchantCity, amount, txid, description }) {
  const { key } = analyzePixKey(pixKey, pixKeyType);
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
