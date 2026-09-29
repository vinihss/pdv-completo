// Chave Pix: canonicalização no cadastro (`docs/11-pix-pendencias.md` §3.1).
//
// O BR Code é gerado no client (`frontend/src/entities/payment/lib/pix.js`),
// que repete estas mesmas regras como rede de segurança — instalação que já
// tem chave salva com máscara continua funcionando. As duas implementações
// precisam concordar, então qualquer mudança aqui vai junto lá.
//
// O que muda no save é o **tipo**: o gerente escolhe em Configurações, e é
// ele que quebrava o desempate dos 11 dígitos (CPF e celular nacional têm o
// mesmo formato). Com o telefone, o DDI é obrigatório — sem ele o app do banco
// lê "51991432485" como CPF e recusa o QR.

export type PixKeyType = "cpf" | "cnpj" | "email" | "phone" | "random";

const E_MAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const EVP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Só dígitos e os separadores de máscara que o formulário aceita. Letra aqui
// já é outra coisa, e a chave fica como veio.
const DIGITOS_E_MASCARA = /^[+\d\s.()/-]+$/;

function canonicalizarTelefone(value: string): string | null {
  const digits = value.replace(/\D/g, "");

  if (value.startsWith("+")) {
    const key = `+${digits}`;
    return key.length >= 3 && key.length <= 15 ? key : null;
  }

  // DDI + DDD + celular (13) ou DDI + DDD + fixo (12).
  if (digits.length >= 12 && digits.startsWith("55")) return `+${digits}`;
  // DDI + DDD + fixo sem o 9 do celular (11 começando por 55).
  if (digits.length === 11 && digits.startsWith("55")) return `+${digits}`;
  // DDD + celular.
  if (digits.length === 11 && digits[2] === "9") return `+55${digits}`;
  // DDD + fixo.
  if (digits.length === 10) return `+55${digits}`;
  // 11 dígitos fora do padrão de celular: o tipo salvo é "phone", então a
  // intenção do gerente manda e o DDI é assumido (o client avisa o formato
  // ambíguo na tela do QR).
  if (digits.length === 11) return `+55${digits}`;

  return null;
}

// Devolve a chave no formato canônico do tipo escolhido. Chave que não cabe no
// tipo volta como veio: recusar o `PUT` inteiro bloquearia o gerente de salvar
// as outras configurações por um erro de um campo, e descartar o que ele
// digitou seria pior. O QR ainda é gerado (com aviso) pelo client.
export function canonicalizePixKey(value: string, type: PixKeyType): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  let canonical: string | null = null;

  if (type === "phone") {
    if (DIGITOS_E_MASCARA.test(raw)) canonical = canonicalizarTelefone(raw);
  } else if (type === "email") {
    if (raw.includes("@")) canonical = raw.toLowerCase().replace(/\s+/g, "");
  } else if (type === "random") {
    if (EVP.test(raw)) canonical = raw.toLowerCase();
  } else if (type === "cpf" || type === "cnpj") {
    if (DIGITOS_E_MASCARA.test(raw)) {
      const digits = raw.replace(/\D/g, "");
      // Dígito verificador não recusa nada aqui: é aviso do client, e
      // reclassificar a chave seria pior do que o app do banco recusar o QR.
      if (digits.length === (type === "cpf" ? 11 : 14)) canonical = digits;
    }
  }

  return canonical ?? raw;
}
