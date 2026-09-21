// BR Code (payload EMV do Pix) — ver 01-backend-spec.md §12.
// Geração 100% client-side: a chave Pix é pública por natureza, não há segredo.
//
// O padrão EMV/BACEN trata o payload como bytes UTF-8: os campos TLV (ID +
// tamanho + valor) declaram o tamanho EM BYTES, e o CRC-16 é calculado sobre
// os bytes UTF-8. Usar comprimento JS (UTF-16) quebra o payload quando há
// acentos (ex: cidade "São Leopoldo"), então tudo aqui é byte-based.

const encoder = new TextEncoder();

// Normaliza pra ASCII (remove acentos): alguns apps de banco e validadores
// rejeitam não-ASCII no payload — "São Leopoldo" vira "Sao Leopoldo".
function ascii(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function utf8Length(value) {
  return encoder.encode(value).length;
}

function truncateBytes(value, max) {
  const bytes = encoder.encode(value);
  if (bytes.length <= max) return value;
  const truncated = new TextDecoder().decode(bytes.slice(0, max)).replace(/\uFFFD/g, "");
  return truncated;
}

function field(id, value) {
  return `${id}${String(utf8Length(value)).padStart(2, "0")}${value}`;
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

export function buildPixPayload({ pixKey, merchantName, merchantCity, amount, txid, description }) {
  const merchantAccountInfo =
    field("00", "BR.GOV.BCB.PIX") +
    field("01", pixKey) +
    (description ? field("02", truncateBytes(ascii(description), 40)) : "");

  const additionalData = field("05", truncateBytes(ascii(txid), 25));

  const payloadWithoutCRC =
    field("00", "01") +
    field("26", merchantAccountInfo) +
    field("52", "0000") +
    field("53", "986") +
    field("54", Number(amount).toFixed(2)) +
    field("58", "BR") +
    field("59", truncateBytes(ascii(merchantName), 25)) +
    field("60", truncateBytes(ascii(merchantCity), 15)) +
    field("62", additionalData) +
    "6304";

  return payloadWithoutCRC + crc16(payloadWithoutCRC);
}
