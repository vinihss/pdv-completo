import test from "node:test";
import assert from "node:assert/strict";
import { createPdvApi } from "./pdvApi.mjs";

const config = {
  apiBaseUrl: "https://loja.exemplo/api/",
  publicOrderUrl: "https://loja.exemplo/pedido",
};

test("consulta pedido ativo por telefone no endpoint público do PDV", async () => {
  let request;
  const api = createPdvApi({ ...config, fetchImpl: async (url, init) => {
    request = { url: String(url), init };
    return { ok: true, json: async () => ({ orderId: "order-1" }) };
  } });
  assert.deepEqual(await api.getActiveOrder("5511999999999"), { orderId: "order-1" });
  assert.equal(request.url, "https://loja.exemplo/api/public/orders/active");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), { phone: "5511999999999" });
});

test("busca fase do pedido e cria link de cardápio/retomada com telefone e canal", async () => {
  const api = createPdvApi({ ...config, fetchImpl: async () => ({ ok: true, json: async () => ({ customerStage: { stage: "preparing" } }) }) });
  assert.deepEqual(await api.getOrderStatus("order/1"), { customerStage: { stage: "preparing" } });
  const menu = new URL(api.makeOrderUrl("5511999999999"));
  assert.equal(menu.pathname, "/pedido");
  assert.equal(menu.searchParams.get("via"), "whatsapp");
  assert.equal(menu.searchParams.get("phone"), "5511999999999");
  const tracking = new URL(api.makeOrderUrl("5511999999999", "order-1"));
  assert.equal(tracking.searchParams.get("order"), "order-1");
});

test("usa /pedido quando PDV_PUBLIC_ORDER_URL aponta apenas para a raiz", () => {
  const api = createPdvApi({ apiBaseUrl: config.apiBaseUrl, publicOrderUrl: "https://loja.exemplo" });
  assert.equal(new URL(api.makeOrderUrl("5511999999999")).pathname, "/pedido");
});

test("não mascara erro HTTP da API do PDV", async () => {
  const api = createPdvApi({ ...config, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(api.getActiveOrder("5511999999999"), /HTTP 503/);
});
