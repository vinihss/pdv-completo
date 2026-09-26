/**
 * Lógica pura do carrinho da página pública (/pedido) — isolada do componente
 * pra ser testável sem render (mesma ideia de features/reports/cashReportView.js).
 *
 * A linha do carrinho é `productId + selectedVariations`: mesmo produto com
 * ponto da carne diferente são duas linhas (espelha o backend, que só conhece
 * productId + selectedVariations na submissão).
 */

/** Chave estável de linha. `selectedVariations` serializado mantém a ordem de inserção dos grupos. */
export function lineKey(productId, selectedVariations) {
  return `${productId}${JSON.stringify(selectedVariations ?? {})}`;
}

/** Linha no formato do backend (customer_cart / POST /public/orders) — sem campos vazios,
 *  pra não divergir do schema (que rejeita "" em notes). */
export function toServerLine(line) {
  return {
    productId: line.productId,
    quantity: line.quantity,
    ...(Object.keys(line.selectedVariations ?? {}).length ? { selectedVariations: line.selectedVariations } : {}),
    ...(line.notes?.trim() ? { notes: line.notes.trim() } : {}),
  };
}

/**
 * Grupos de variação de um produto, normalizados.
 * O menu público devolve `[{ name, options, required, allowMultiple }]` (o
 * mesmo formato do payload interno), mas aceitamos também o formato antigo
 * (`Record<grupo, opções[]>`) — cardápio em cache ou backend desatualizado não
 * pode quebrar a tela.
 */
export function variationGroups(product) {
  const raw = product?.variations;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    // Mesma regra do backend (domain/variations.ts#normalizeVariations): grupo
    // sem nome ou sem opções não existe. Divergir aqui abriria a tela com um
    // grupo que o servidor rejeitaria.
    return raw
      .filter(
        (g) =>
          g &&
          typeof g.name === "string" &&
          g.name.trim().length > 0 &&
          Array.isArray(g.options) &&
          g.options.length > 0
      )
      .map((g) => ({
        name: g.name.trim(),
        options: g.options,
        required: Boolean(g.required),
        allowMultiple: Boolean(g.allowMultiple),
      }));
  }
  if (typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, options]) => Array.isArray(options) && options.length > 0)
      .map(([name, options]) => ({ name, options, required: false, allowMultiple: false }));
  }
  return [];
}

/** Produto tem opções a escolher? (abre o modal em vez de adicionar direto) */
export function hasVariations(product) {
  return variationGroups(product).length > 0;
}

function selectedOptions(selected, group) {
  const v = selected?.[group];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((o) => typeof o === "string" && o.trim().length > 0);
}

/**
 * Grupos obrigatórios sem seleção. Espelha `missingRequiredGroups` do backend
 * (domain/variations.ts) — o servidor revalida no checkout, aqui é pra travar
 * a linha já no carrinho em vez de deixar o cliente descobrir no 422.
 */
export function missingRequiredGroups(groups, selected) {
  return groups.filter((g) => g.required && selectedOptions(selected, g.name).length === 0).map((g) => g.name);
}


/** Todas as linhas do carrinho que pertencem a um produto (cada variação = 1 linha). */
export function linesOfProduct(cart, productId) {
  return Object.entries(cart ?? {})
    .filter(([, line]) => line.productId === productId)
    .map(([key, line]) => ({ key, ...line }));
}

/** Quantidade total do produto no carrinho (soma de todas as linhas/variações). */
export function productQty(cart, productId) {
  return linesOfProduct(cart, productId).reduce((sum, l) => sum + l.quantity, 0);
}

