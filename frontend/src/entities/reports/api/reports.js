import { request } from "@/shared/api/http";

export function salesReport(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/reports/sales${qs ? `?${qs}` : ""}`);
}

/**
 * Visão geral: vendas agrupadas por período, para o gráfico.
 *
 * `tz` viaja porque o dia do restaurante não é o dia UTC: sem o offset, uma
 * venda das 22h cai no dia seguinte no gráfico. `browserTzOffset()` é o mesmo
 * helper que o resumo de caixa já usa.
 */
export function overviewReport(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/reports/overview${qs ? `?${qs}` : ""}`);
}
/**
 * Relatório de entregas: volume, no-prazo e tempo médio por entregador.
 * Mesmo `tz` da visão geral pelo mesmo motivo — o dia do relatório é o dia da
 * loja, não o dia UTC.
 */
export function deliveriesReport(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/reports/deliveries${qs ? `?${qs}` : ""}`);
}
