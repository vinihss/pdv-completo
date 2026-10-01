/**
 * Motivos de falha em um toque.
 *
 * Digitar motivo com luva, no sol, em 4G de rua é a pior interação possível —
 * e o motivo é o texto que o cliente e o gerente leem depois. Os 5 presets
 * cobrem o que realmente acontece na rua; o campo continua editável para o
 * que não couber ("portão fechado, vizinho não sabe").
 *
 * Ordem: do mais comum ao mais raro, e o que o cliente recebe primeiro é o
 * que ele mais precisa ler.
 */
export const FAIL_PRESETS = [
  "Cliente ausente",
  "Endereço errado",
  "Recusou o pedido",
  "Contato impossível",
  "Produto indisponível",
];