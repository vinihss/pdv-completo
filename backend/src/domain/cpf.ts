/**
 * CPF: conferência dos dois dígitos verificadores (módulo 11).
 *
 * Função pura e sem I/O — quem chama decide o que fazer com o `false` (a
 * aplicação rejeita o cadastro com `validation_failed`, a tela avisa antes de
 * enviar). O mesmo algoritmo roda no frontend
 * (`frontend/src/entities/payment/lib/pix.js#validarCpf`) para dar o retorno
 * imediato, mas a conferência DEFINITIVA é a do servidor: cliente pode ser
 * editado por outra máquina e o banco não guarda CPF inválido.
 *
 * Por que o módulo 11 e não uma biblioteca: são 20 linhas, zero dependência,
 * e a regra é estável há décadas. Um `cpf` errado grava documento que não
 * existe no documento da Receita — o tipo de dado que ninguém percebe que está
 * errado até precisar dele numa nota fiscal.
 */
import { Errors } from "./errors.js";

function digitoVerificador(base: string, pesos: number[]): number {
  const soma = [...base].reduce((acc, digito, i) => acc + Number(digito) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * `digits` precisa vir JÁ normalizado (só dígitos). A normalização — tirar
 * pontuação e barra, checar o tamanho — é do usecase, porque só ele sabe o
 * que fazer com "não informado" (que é `null`, não erro). Aqui só mora a
 * conferência do documento em si.
 */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;

  // `111.111.111-11` e companhia passam no módulo 11 (os dois dígitos fecham
  // certinho), mas a Receita nunca emitiu um CPF de dígitos repetidos. Sem
  // esta guarda o clássico "11111111111" entraria como documento válido — e é
  // exatamente o valor que alguém digita para "testar" o formulário.
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const base = digits.slice(0, 9);
  const d1 = digitoVerificador(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoVerificador(base + String(d1), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return Number(digits[9]) === d1 && Number(digits[10]) === d2;
}

/**
 * CPF para os 11 dígitos crus, ou `null` quando não informado.
 *
 * Aceita com ou sem máscara ("529.982.247-25" e "52998224725" viram o mesmo
 * valor) pelo mesmo motivo do telefone e do CEP: a tela mascara, o banco não.
 * Vazio é `null` e não erro — o CPF é documento opcional, e cliente
 * sem ele tem que continuar cadastrável.
 *
 * Já valida os dígitos verificadores: um CPF que a Receita não emitiu é
 * documento falso, e o lugar de recusar isso é na entrada, não na emissão da
 * nota.
 */
export function normalizeCpf(cpf: string | null | undefined): string | null {
  const digits = (cpf ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (!isValidCpf(digits)) throw Errors.validationFailed({ field: "cpf", reason: "CPF inválido" });
  return digits;
}