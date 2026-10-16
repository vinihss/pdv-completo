const STORAGE_KEY = "pdv:public-cart";
const TTL_MS = 24 * 60 * 60 * 1000;

export function saveCartLocal(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items, savedAt: Date.now() }));
  } catch {}
}

export function loadCartLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.items)) return null;
    if (Date.now() - (data.savedAt ?? 0) > TTL_MS) {
      clearCartLocal();
      return null;
    }
    return data.items.filter((it) => it?.productId && it.quantity > 0);
  } catch {
    return null;
  }
}

export function clearCartLocal() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
