// Variações de produto: formato estruturado de grupos (§01 backend-spec,
// tabela product). Antes vivia em application/product.usecases.ts — foi
// extraído pra cá porque a validação do checkout self-service precisa dela
// sem arrastar a camada de aplicação (e o menu público monta o payload com o
// mesmo shape, pra página e garçom compartilharem o modal de seleção).
//
//   [{ name: "Ponto da carne", options: ["Mal passado", ...], required?, allowMultiple? }]
//
// Arrays legados (lista plana de strings, ex. seed antigo) são normalizados na
// leitura para um único grupo "Opção" — compatível com `selectedVariations`
// persistido como Record<grupo, opção> (e opção múltipla como string[]).
export interface VariationGroup {
  name: string;
  options: string[];
  required: boolean;
  allowMultiple: boolean;
}

export type SelectedVariations = Record<string, string | string[]>;

export function normalizeVariations(raw: unknown): VariationGroup[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  // Legado: ["Limão", "Morango"] → [{ name: "Opção", options: [...] }]
  if (typeof raw[0] === "string") {
    const options = (raw as unknown[])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
    return options.length ? [{ name: "Opção", options, required: false, allowMultiple: false }] : [];
  }

  return (raw as any[])
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) => ({
      name: typeof g.name === "string" ? g.name.trim() : "",
      options: Array.isArray(g.options)
        ? g.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
        : [],
      required: Boolean(g.required),
      allowMultiple: Boolean(g.allowMultiple),
    }))
    .filter((g) => g.name.length > 0 && g.options.length > 0);
}

// `product.variations` é text no SQLite (drizzle sem mode:'json') e pode
// veio de seed antigo com JSON inválido — parse tolerante, devolve [].
export function parseVariations(raw: string | null | undefined): VariationGroup[] {
  if (!raw) return [];
  try {
    return normalizeVariations(JSON.parse(raw));
  } catch {
    return [];
  }
}

function selectionOf(selected: SelectedVariations | undefined, group: string): string[] {
  const v = selected?.[group];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((o) => String(o).trim()).filter(Boolean);
}

// Grupos obrigatórios sem seleção — é o que impede um pedido de X-Burger
// chegar na cozinha sem "Ponto da carne".
export function missingRequiredGroups(
  groups: VariationGroup[],
  selected: SelectedVariations | undefined
): string[] {
  return groups.filter((g) => g.required && selectionOf(selected, g.name).length === 0).map((g) => g.name);
}

// Opções selecionadas que não existem mais no grupo (produto alterado no
// catálogo entre a montagem do carrinho e o checkout, ou cliente forjando o
// payload) — rejeitar é melhor que mandar a cozinha um pedido impossível.
export function unknownOptions(
  groups: VariationGroup[],
  selected: SelectedVariations | undefined
): { group: string; option: string }[] {
  const out: { group: string; option: string }[] = [];
  for (const g of groups) {
    for (const option of selectionOf(selected, g.name)) {
      if (!g.options.includes(option)) out.push({ group: g.name, option });
    }
  }
  return out;
}
