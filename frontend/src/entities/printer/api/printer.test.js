import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printOrder, getPrintStatus, getPrinterStatus, getPrinterHealth, PrinterUnavailableError } from "./printer.js";
import { setAppConfig } from "@/shared/lib/appConfig";

/**
 * O navegador fala direto com o daemon em 127.0.0.1:8080. O teste trava o que
 * o operador vê quando isso falha: sem daemon, com daemon devolvendo erro, e
 * — o mais difícil de diagnosticar em campo — quando o navegador bloqueia a
 * chamada por CORS, que chega como `fetch failed` indistinguível de "daemon
 * fora do ar".
 */

const order = {
  id: "ord-1",
  channel: "balcao",
  openedAt: "2026-09-29T12:00:00.000Z",
  tabLabel: "A-1",
  items: [{ name: "Pizza", quantity: 1, unitPrice: 50, selectedVariations: {}, notes: null, status: "ordered" }],
  payments: [],
};

let fetchMock;

function mockFetch(impl) {
  fetchMock = vi.fn(impl);
  globalThis.fetch = fetchMock;
}

function ok(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  setAppConfig(null); // modo web: sem config, usa o loopback
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printOrder", () => {
  it("chama o daemon no loopback com o payload do pedido", async () => {
    mockFetch(async () => ok({ job_id: "ord-1-kitchen", status: "sent_to_printer" }));
    const result = await printOrder(order, "kitchen");
    expect(result.status).toBe("sent_to_printer");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8080/api/print");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent.job_id).toBe("ord-1-kitchen");
    expect(sent.order.total_cents).toBe(5000);
  });

  it("usa a URL de daemon configurada no app desktop", async () => {
    setAppConfig({ mode: "local", apiBase: "", daemonUrl: "http://127.0.0.1:9090" });
    mockFetch(async () => ok({ status: "queued" }));
    await printOrder(order, "kitchen");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9090/api/print");
  });

  it("traduz falha de conexão em erro com instrução", async () => {
    // `fetch failed` cobre daemon fora do ar, porta fechada e CORS bloqueado.
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(printOrder(order, "kitchen")).rejects.toBeInstanceOf(PrinterUnavailableError);
    await expect(printOrder(order, "kitchen")).rejects.toThrow(/serviço de impressão está rodando/);
  });

  it("propaga a mensagem do daemon quando ele recusa o trabalho", async () => {
    mockFetch(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: "template kitchen-default não encontrado" }),
    }));
    await expect(printOrder(order, "kitchen")).rejects.toThrow("template kitchen-default não encontrado");
  });

  it("não quebra quando o erro não vem em JSON", async () => {
    mockFetch(async () => ({ ok: false, status: 500, text: async () => "<html>500</html>" }));
    await expect(printOrder(order, "kitchen")).rejects.toThrow(/HTTP 500/);
  });
});

describe("getPrintStatus", () => {
  it("filtra os jobs da comanda pedida", async () => {
    mockFetch(async () =>
      ok([
        { id: "ord-1-kitchen", order_id: "ord-1", status: "sent_to_printer" },
        { id: "ord-2-kitchen", order_id: "ord-2", status: "queued" },
      ]),
    );
    const jobs = await getPrintStatus("ord-1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("ord-1-kitchen");
  });
});

describe("getPrinterStatus", () => {
  it("consulta um destino", async () => {
    mockFetch(async () => ok({ destination: "kitchen", ready: true }));
    const result = await getPrinterStatus("kitchen");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8080/api/printers/status?destination=kitchen");
    expect(result.ready).toBe(true);
  });

  it("consulta todos quando não há destino", async () => {
    mockFetch(async () => ok({}));
    await getPrinterStatus();
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8080/api/printers/status");
  });
});

describe("getPrinterHealth", () => {
  it("lê o /health do daemon", async () => {
    mockFetch(async () => ok({ status: "ok", ready: true, queue_depth: 0 }));
    const result = await getPrinterHealth();
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8080/health");
    expect(result.ready).toBe(true);
  });
});
