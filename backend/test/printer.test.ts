import http from "node:http";
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, raw, resetState, seedFixture, testApp, waiter, manager } from "./helpers.js";

/**
 * Impressão térmica — integração PDV ↔ daemon local (printer/).
 *
 * O daemon real é substituído por um stub HTTP local. A URL dele vem do
 * `env` do vitest.config (porta fixa 3456) porque `src/config/env.ts` é um
 * snapshot feito no load do módulo.
 *
 * O que esta suíte protege:
 *  - impressão automática da cozinha quando itens são lançados (flags ligadas);
 *  - NÃO imprimir quando printerEnabled=false ou printerAutoPrint=false;
 *  - impressão manual via endpoint POST /orders/:id/print;
 *  - status dos jobs e health check.
 */

const STUB_PORT = 3456;

interface PrintCall {
  job_id: string;
  order_id: string;
  destination: string;
  order: any;
}

let server: http.Server;
let calls: PrintCall[] = [];
let daemonDown = false;

function resetDaemon() {
  calls = [];
  daemonDown = false;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (daemonDown) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", message: "daemon offline" }));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/print") {
      const body = await readBody(req);
      calls.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job_id: body.job_id, status: "sent_to_printer" }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/jobs") {
      const jobs = calls.map((c, i) => ({
        id: c.job_id,
        order_id: c.order_id,
        destination: c.destination,
        status: "sent_to_printer",
        attempts: 1,
        last_error: "",
        next_attempt_at: "",
        created_at: `2026-09-27T12:00:0${i}Z`,
        updated_at: `2026-09-27T12:00:0${i}Z`,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jobs));
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/printers/status")) {
      const dest = new URL(req.url, "http://localhost").searchParams.get("destination");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          destination: dest,
          address: "192.168.1.50:9100",
          reachable: true,
          status_supported: true,
          ready: true,
          paper: "ok",
          cover_open: false,
          offline: false,
          error: false,
          cutter_error: false,
          raw: { n1: 22, n2: 0, n3: 0, n4: 0 },
          checked_at: "2026-09-27T12:00:00Z",
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(STUB_PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await seedFixture();
  // Seed sem resetState deixava a mesa t-1 ocupada pela comanda do teste
  // anterior (409), quebrando os testes seguintes na sequência completa —
  // isolados passavam por sorte de ordem.
  await resetState();
  resetDaemon();
});

describe("Impressão térmica — flags desligadas (default)", () => {
  it("não imprime na cozinha quando printerEnabled=false", async () => {
    // Fixture default é printerEnabled=false
    const order = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: "t-1" },
    });
    expect(order.status).toBe(201);

    await api("post", `/orders/${order.json.id}/items`, {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), items: [{ productId: "p-1", quantity: 2 }] },
    });

    // espera o fire-and-forget resolver
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(0);
  });
});

describe("Impressão térmica — auto-print ligado", () => {
  beforeEach(async () => {
    await raw.exec(
      `UPDATE store_settings SET printer_enabled = true, printer_auto_print = true WHERE id = 'singleton'`
    );
  });

  it("imprime na cozinha quando itens são lançados", async () => {
    const order = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: "t-1" },
    });

    await api("post", `/orders/${order.json.id}/items`, {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), items: [{ productId: "p-1", quantity: 2 }] },
    });

    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toHaveLength(1);
    expect(calls[0].destination).toBe("kitchen");
    expect(calls[0].order_id).toBe(order.json.id);
    expect(calls[0].order.items).toHaveLength(1);
    expect(calls[0].order.items[0].name).toBe("Chopp 300ml");
    expect(calls[0].order.total_cents).toBeGreaterThan(0);
  });

  it("não imprime na cozinha quando printerAutoPrint=false", async () => {
    await raw.exec(
      `UPDATE store_settings SET printer_enabled = true, printer_auto_print = false WHERE id = 'singleton'`
    );

    const order = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: "t-1" },
    });

    await api("post", `/orders/${order.json.id}/items`, {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), items: [{ productId: "p-1", quantity: 1 }] },
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(0);
  });
});

describe("Impressão térmica — manual", () => {
  beforeEach(async () => {
    await raw.exec(
      `UPDATE store_settings SET printer_enabled = true WHERE id = 'singleton'`
    );
  });

  it("imprime manualmente via POST /orders/:id/print", async () => {
    const order = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: "t-1" },
    });

    const res = await api("post", `/orders/${order.json.id}/print`, {
      token: waiter,
      body: { destination: "kitchen" },
    });

    expect(res.status).toBe(200);
    expect(res.json.destination).toBeUndefined(); // resposta do daemon
    expect(res.json.job_id).toBe(`${order.json.id}-kitchen`);
  });

  it("imprime manualmente para courier", async () => {
    const order = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: "t-1" },
    });

    const res = await api("post", `/orders/${order.json.id}/print`, {
      token: waiter,
      body: { destination: "courier" },
    });

    expect(res.status).toBe(200);
  });

  it("retorna 404 para comanda inexistente", async () => {
    const res = await api("post", `/orders/nonexistent/print`, {
      token: waiter,
      body: { destination: "kitchen" },
    });
    expect(res.status).toBe(404);
  });

  it("garçom não pode ver status da impressora (manager only)", async () => {
    const res = await api("get", "/printers/status", { token: waiter });
    expect(res.status).toBe(403);
  });

  it("gerente vê status da impressora", async () => {
    const res = await api("get", "/printers/status", { token: manager });
    expect(res.status).toBe(200);
    expect(res.json.printers).toHaveLength(2);
  });
});

describe("Impressão térmica — health check", () => {
  it("retorna online quando daemon responde", async () => {
    const res = await api("get", "/printers/health", { token: manager });
    expect(res.status).toBe(200);
    expect(res.json.daemon).toBe("online");
  });

  it("retorna offline quando daemon não responde", async () => {
    daemonDown = true;
    const res = await api("get", "/printers/health", { token: manager });
    expect(res.status).toBe(200);
    expect(res.json.daemon).toBe("offline");
    daemonDown = false;
  });
});
