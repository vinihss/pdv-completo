import { request } from "@/shared/api/http";

// ---------- Carrinho server-side (continuação do pedido) ----------

export function getPublicCart(phone) {
  return request("GET", `/public/cart?phone=${encodeURIComponent(phone)}`);
}

// items: [{ productId, quantity, selectedVariations?, notes }]
export function savePublicCart(phone, items) {
  return request("PUT", "/public/cart", { phone, items });
}

export function clearPublicCart(phone) {
  return request("DELETE", "/public/cart", { phone });
}
