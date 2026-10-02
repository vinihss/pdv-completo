// Validação de CPF do cadastro de cliente.
//
// Espelha o `validarCpf` de `@/entities/payment/lib/pix.js` (chave Pix do
// tipo "cpf") em vez de importar dele: a entidade `payment` não devia ser
// dependência de `customer` só por um cálculo de dígito verificador, e o
// cálculo é dez linhas.
//
// A diferença em relação ao do Pix é a rejeição dos dígitos repetidos
// (000.000.000-00, 111.111.111-11, ...): eles passam na conta do DV, então
// sem essa guarda o formulário aceitaria um CPF que o backend — que recusa no
// INSERT por ser único — rejeitaria depois, com mensagem de banco em vez de
// mensagem de campo.

function digitoVerificador(base, pesos) {
  const soma = [...base].reduce((acc, digito, i) => acc + Number(digito) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** Só os dígitos, do jeito que o backend guarda (11 cru, sem máscara). */
export function cpfDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function validarCpf(cpf) {
  const digits = cpfDigits(cpf);
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const base = digits.slice(0, 9);
  const d1 = digitoVerificador(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoVerificador(base + d1, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return Number(digits[9]) === d1 && Number(digits[10]) === d2;
}
