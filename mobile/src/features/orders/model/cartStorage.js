// Persistência do carrinho de lançamento por comanda — mesma ideia do
// `cartStorage` do web (frontend/src/entities/cart/model/cartStorage.js), mas
// sobre o adapter síncrono de storage do app (MMKV) e com escopo por comanda:
// o tablet pode ter a comanda 12 na tela, sair dela e voltar — o lançamento
// pendente não pode se perder. Limpo ao confirmar (ou expira em 6h).
//
// A linha salva carrega um snapshot do produto (nome/preço) para a revisão
// renderizar sem depender de refetch do catálogo.

import { storage } from "@/shared/lib/storage";

const STORAGE_PREFIX = "pdv:order-cart";
const TTL_MS = 6 * 60 * 60 * 1000;

function keyOf(orderId) {
  return `${STORAGE_PREFIX}:${orderId}`;
}

export function saveCart(orderId, cart) {
  const lines = Object.values(cart ?? {});
  if (lines.length === 0) {
    clearCart(orderId);
    return;
  }
  try {
    storage.setItem(
      keyOf(orderId),
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        items: lines.map((l) => ({
          key: l.key,
          product: {
            id: l.product.id,
            name: l.product.name,
            price: l.product.price,
          },
          quantity: l.quantity,
          selectedVariations: l.selectedVariations ?? {},
          notes: l.notes ?? "",
        })),
      })
    );
  } catch {
    /* storage cheio/corrompido: o lançamento continua só em memória */
  }
}

function isExpired(savedAt) {
  return Date.now() - (savedAt ?? 0) > TTL_MS;
}

/**
 * Carrega e reconstrói o carrinho. Linhas sem produto válido (produto
 * removido do cardápio entre uma sessão e outra) são descartadas — o item
 * deixa de existir no backend, então confirmar falharia no 422.
 */
export function loadCart(orderId) {
  try {
    const raw = storage.getItem(keyOf(orderId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.items)) return null;
    if (isExpired(data.savedAt)) {
      clearCart(orderId);
      return null;
    }
    const cart = {};
    for (const it of data.items) {
      if (!it?.product?.id || !it.product.name) continue;
      cart[it.key] = {
        key: it.key,
        product: { id: it.product.id, name: it.product.name, price: Number(it.product.price) || 0 },
        quantity: Math.max(1, Number(it.quantity) || 1),
        selectedVariations: it.selectedVariations ?? {},
        notes: it.notes ?? "",
      };
    }
    return Object.keys(cart).length > 0 ? cart : null;
  } catch {
    return null;
  }
}

export function clearCart(orderId) {
  try {
    storage.removeItem(keyOf(orderId));
  } catch {
    /* nada a limpar */
  }
}