// Lógica pura do carrinho de lançamento do garçom — isolada dos componentes
// para ser testável sem render. Porta as ideias de
// frontend/src/entities/cart/model/cartLogic.js (menu público) para o fluxo
// interno; os helpers de variação são o mesmo 1:1.

/**
 * A linha do carrinho é `productId + selectedVariations`: mesmo produto com
 * ponto da carne diferente são duas linhas (espelha o backend, que só conhece
 * productId + selectedVariations na submissão).
 */
export function lineKey(productId, selectedVariations) {
  return `${productId}${JSON.stringify(selectedVariations ?? {})}`;
}

export function crtLine({ product, quantity = 1, selectedVariations = {}, notes = "" }) {
  return {
    key: lineKey(product.id, selectedVariations),
    product,
    quantity,
    selectedVariations,
    notes,
  };
}

/** Adiciona 1 à linha existente ou cria uma nova. */
export function addLine(cart, product, selectedVariations = {}) {
  const line = crtLine({ product, selectedVariations });
  const existing = cart[line.key];
  return {
    ...cart,
    [line.key]: existing
      ? { ...existing, quantity: existing.quantity + 1 }
      : { ...line, quantity: 1 },
  };
}

/** Remove a linha inteira (não tem "diminuir" no app — o fluxo é revisar e tirar). */
export function removeLine(cart, key) {
  if (!(key in cart)) return cart;
  const next = { ...cart };
  delete next[key];
  return next;
}

export function changeNotes(cart, key, notes) {
  const existing = cart[key];
  if (!existing) return cart;
  return { ...cart, [key]: { ...existing, notes } };
}

/** Quantidade total do produto no carrinho (soma de todas as linhas/variações). */
export function productQty(cart, productId) {
  return Object.values(cart ?? {})
    .filter((l) => l.product.id === productId)
    .reduce((sum, l) => sum + l.quantity, 0);
}

export function cartLines(cart) {
  return Object.values(cart ?? {});
}

export function cartCount(cart) {
  return cartLines(cart).reduce((sum, l) => sum + l.quantity, 0);
}

export function cartTotal(cart) {
  return cartLines(cart).reduce((sum, l) => sum + l.product.price * l.quantity, 0);
}

/** Linhas no formato que o backend espera em POST /orders/:id/items. */
export function toServerItems(cart) {
  return cartLines(cart).map((l) => ({
    productId: l.product.id,
    quantity: l.quantity,
    ...(Object.keys(l.selectedVariations ?? {}).length ? { selectedVariations: l.selectedVariations } : {}),
    ...(l.notes?.trim() ? { notes: l.notes.trim() } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Variações (mesma regra do web — ver frontend/src/entities/cart/model/cartLogic.js)
// ---------------------------------------------------------------------------

/**
 * Grupos de variação de um produto, normalizados. O cardápio devolve
 * `[{ name, options, required, allowMultiple }]`; o formato antigo
 * (`Record<grupo, opções[]>`) também é aceito — backend desatualizado não
 * pode quebrar a tela.
 */
export function variationGroups(product) {
  const raw = product?.variations;
  if (!raw) return [];
  if (Array.isArray(raw)) {
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
 * (domain/variations.ts) — o servidor revalida no POST, aqui é pra travar a
 * linha já no carrinho.
 */
export function missingRequiredGroups(groups, selected) {
  return groups.filter((g) => g.required && selectedOptions(selected, g.name).length === 0).map((g) => g.name);
}