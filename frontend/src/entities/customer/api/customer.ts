import { request, upload } from "@/shared/api/http";

// Busca leve do garçom (abrir comanda com cliente) — array simples.
export function searchCustomers(q) {
  return request("GET", `/customers/search${q ? `?q=${encodeURIComponent(q)}` : ""}`);
}

// ---------- Clientes (manutenção gerente/caixa) ----------

export async function listAllCustomers(params = {}) {
  const size = 200;
  let offset = 0;
  const all = [];
  for (;;) {
    const { data, total } = await request(
      "GET",
      `/customers?${new URLSearchParams({ ...params, limit: String(size), offset: String(offset) })}`
    );
    all.push(...data);
    offset += data.length;
    if (all.length >= total || data.length === 0) break;
  }
  return { data: all, total: all.length };
}

// Ficha completa: endereços e comandas em aberto junto do cadastro. É o que a
// tela de visualização consome (o `CustomerModal` já usa para os endereços).
export function getCustomer(id) {
  return request("GET", `/customers/${id}`);
}

export function createCustomer(body) {
  return request("POST", "/customers", body);
}

// Aceita `cpf` e `notes` além de nome/contato — o formulário do modal é quem
// valida o DV antes de mandar (ver `model/cpf.js`).
export function updateCustomer(id, body) {
  return request("PATCH", `/customers/${id}`, body);
}

// ---------- Foto do cliente ----------
// Upload imediato no `onChange` (mesmo padrão do `UserModal`): o arquivo não
// espera o PATCH do cadastro, e o backend devolve o `photoPath` novo.

export function uploadCustomerPhoto(id, file) {
  return upload(`/customers/${id}/photo`, "photo", file);
}

export function removeCustomerPhoto(id) {
  return request("DELETE", `/customers/${id}/photo`);
}

// ---------- Histórico do cliente ----------
// Paginado de propósito: a ficha abre com as primeiras ordens (prévia) e
// "Carregar mais" pede a próxima página. `total` é o total do conjunto todo,
// não da página.
//
// Só `limit`/`offset`: o filtro por dia do gráfico é feito na tela (ver
// `CustomerDetailScreen`), porque a regra do gráfico é "comanda FECHADA no dia
// do fechamento" — o dia em que a comanda foi aberta não é o dia em que ela
// entrou no gráfico. Quando a rota ganhar filtro de data, o parâmetro entra
// aqui; o filtro do cliente continua sendo o que decide o que aparece.
export function listCustomerOrders(id, { limit = 20, offset = 0 } = {}) {
  const params = { limit: String(limit), offset: String(offset) };
  return request("GET", `/customers/${id}/orders?${new URLSearchParams(params)}`);
}

// Série diária para o gráfico da ficha. O backend devolve `label` já em pt-BR
// e um ponto por dia do período (com `total: 0` nos dias sem venda), então a
// tela não monta calendário nenhum — e nunca rotula o eixo com `toLocaleDateString`.
//
// `tz` viaja pelo mesmo motivo dos relatórios: sem o offset o backend agrupa em
// UTC, e uma conta fechada às 23h cai no dia seguinte no gráfico.
export function getCustomerSummary(id, days = 30, tz) {
  const params = new URLSearchParams({ days: String(days) });
  if (tz) params.set("tz", tz);
  return request("GET", `/customers/${id}/summary?${params}`);
}

export function addCustomerAddress(customerId, address) {
  return request("POST", `/customers/${customerId}/addresses`, address);
}

export function setDefaultCustomerAddress(customerId, addressId) {
  return request("POST", `/customers/${customerId}/addresses/${addressId}/default`);
}

export function deleteCustomerAddress(customerId, addressId) {
  return request("DELETE", `/customers/${customerId}/addresses/${addressId}`);
}
