function absoluteUrl(value, label) {
  if (!value) throw new Error(`${label} não configurado.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} deve ser uma URL absoluta.`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${label} deve usar HTTP ou HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} não deve conter usuário ou senha.`);
  return url;
}

export function createPdvApi({ apiBaseUrl, publicOrderUrl, fetchImpl = globalThis.fetch }) {
  const apiConfigured = Boolean(apiBaseUrl);
  const orderUrlConfigured = Boolean(publicOrderUrl);

  async function request(path, init = {}) {
    const base = absoluteUrl(apiBaseUrl, "PDV_API_BASE_URL");
    const url = new URL(`${base.toString().replace(/\/+$/, "")}${path}`);
    const response = await fetchImpl(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) throw new Error(`A API do PDV respondeu HTTP ${response.status}.`);
    return payload;
  }

  return {
    configured: apiConfigured && orderUrlConfigured,
    apiConfigured,
    orderUrlConfigured,
    async getActiveOrder(phone) {
      return request("/public/orders/active", { method: "POST", body: JSON.stringify({ phone }) });
    },
    async getOrderStatus(orderId) {
      return request(`/public/orders/${encodeURIComponent(orderId)}/status`);
    },
    makeOrderUrl(phone, orderId) {
      const url = absoluteUrl(publicOrderUrl, "PDV_PUBLIC_ORDER_URL");
      if (url.pathname === "/") url.pathname = "/pedido";
      url.searchParams.set("via", "whatsapp");
      url.searchParams.set("phone", phone);
      if (orderId) url.searchParams.set("order", orderId);
      return url.toString();
    },
  };
}
