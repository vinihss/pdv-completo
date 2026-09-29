import { daemonBase } from "@/shared/lib/appConfig";
import { toPrintRequest } from "../lib/daemonOrder.js";

/**
 * Impressão térmica — o navegador fala **direto** com o daemon local.
 *
 * O daemon roda na mesma máquina que o navegador (`127.0.0.1:8080`), então
 * não há túnel, IP público nem proxy no meio. O pedido de impressão não
 * passa pelo backend: quem monta o cupom é a tela, com o mesmo total que o
 * operador vê (`orderTotal`).
 *
 * Consequência: o caminho de **impressão automática** (disparado pelo backend
 * ao abrir a comanda) exige `PRINTER_DAEMON_URL` alcançável a partir do
 * container do backend. Com o daemon só na máquina do usuário e o backend na
 * VPS, esse caminho não funciona — desligue `printerAutoPrint` e use o botão
 * de imprimir. Ver `docs/agent-frontend.md`.
 */

const TIMEOUT_MS = 8000;

export class PrinterUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "PrinterUnavailableError";
    this.cause = cause;
  }
}

async function daemonFetch(path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${daemonBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    // `fetch failed` cobre daemon fora do ar, porta fechada e CORS bloqueado
    // — o navegador não distingue os três no erro. A mensagem aponta para o
    // caso comum (config) e cita a origem, que é o outro culpado frequente.
    throw new PrinterUnavailableError(
      "Não foi possível falar com a impressora. Verifique se o serviço de impressão está rodando e se a origem do app está liberada nele.",
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function daemonRequest(path, init) {
  const res = await daemonFetch(path, init);
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw new Error(body?.message || `Falha na impressão (HTTP ${res.status}).`);
  }
  return body;
}

export async function printOrder(order, destination) {
  return daemonRequest("/api/print", {
    method: "POST",
    body: JSON.stringify(toPrintRequest(order, destination)),
  });
}

export async function getPrintStatus(orderId) {
  const jobs = await daemonRequest("/api/jobs");
  return (jobs ?? []).filter((j) => j.order_id === orderId);
}

export async function getPrinterStatus(destination) {
  const qs = destination ? `?destination=${encodeURIComponent(destination)}` : "";
  return daemonRequest(`/api/printers/status${qs}`);
}

export async function getPrinterHealth() {
  return daemonRequest("/health");
}
