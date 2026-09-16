import http from "node:http";
import { ifoodConfig } from "./config.js";
import { ifoodStateKeys, setIfoodState } from "./state.js";
import type { IfoodEvent, IfoodOrder } from "./order.types.js";

// Mock local da iFood API para desenvolvimento S/ credenciais reais:
// sobe um http server em IFOOD_MOCK_PORT implementando os mesmos endpoints
// que o ifood/client.ts consome (auth, order, catalog) + endpoints administrativos
// para injetar fixtures e inspecionar as chamadas. Quando IFOOD_MOCK=true, o
// client aponta para este servidor (via ifoodConfig.baseUrl).

interface MockState {
  merchant: { id: string; name: string };
  catalogId: string;
  categories: Array<{ id: string; name: string }>;
  items: Array<Record<string, unknown>>;
  pendingEvents: IfoodEvent[];
  orders: Record<string, IfoodOrder>; // key: event.orderId
  log: {
    polledAt: string[];
    acked: string[];
    confirms: string[];
    startPreparation: string[];
    readyToPickup: string[];
    dispatched: string[];
    cancellations: Array<{ orderId: string; reason?: string }>;
    catalog: Array<{ at: string; op: string; deet?: string }>;
    ordersFetched: string[];
  };
}

let state: MockState = {
  merchant: { id: "00000000-0000-0000-0000-00000000Mock", name: "Restaurante Mock iFood" },
  catalogId: "catalog-mock-0001",
  categories: [],
  items: [],
  pendingEvents: [],
  orders: {},
  log: {
    polledAt: [],
    acked: [],
    confirms: [],
    startPreparation: [],
    readyToPickup: [],
    dispatched: [],
    cancellations: [],
    catalog: [],
    ordersFetched: [],
  },
};

export function loadIfoodMockFixtures(fixtures: { events?: IfoodEvent[]; order?: IfoodOrder }) {
  if (fixtures.events) {
    for (const ev of fixtures.events) {
      if (fixtures.order && ev.orderId === fixtures.order.id) {
        state.orders[ev.orderId] = fixtures.order;
      }
      if (!state.pendingEvents.find((p) => p.id === ev.id)) state.pendingEvents.push(ev);
    }
  }
  if (fixtures.order && !state.orders[fixtures.order.id]) state.orders[fixtures.order.id] = fixtures.order;
}

export function getIfoodMockState(): MockState {
  return state;
}

function send(res: http.ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function startIfoodMock(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${ifoodConfig.mockPort}`);
    const { pathname } = url;
    const method = (req.method ?? "GET").toUpperCase();
    const json = () => readBody(req);
    const log = (op: string, deet?: string) => state.log.catalog.push({ at: new Date().toISOString(), op, deet });

    try {
      // ---- administrativo ----
      if (method === "POST" && pathname === "/__fixtures") {
        const body = (await json()) as { events?: IfoodEvent[]; order?: IfoodOrder };
        loadIfoodMockFixtures(body ?? {});
        return send(res, 200, { ok: true });
      }
      if (method === "GET" && pathname === "/__log") return send(res, 200, state.log);
      if (method === "GET" && pathname === "/__state") return send(res, 200, { ...state, orders: undefined });

      // ---- autenticação ----
      if (method === "POST" && pathname === "/authentication/v1.0/oauth/token") {
        return send(res, 200, { accessToken: "mock-access-token", expiresIn: 21_600 });
      }
      if (method === "GET" && pathname === "/authentication/v1.0/merchants") {
        return send(res, 200, [state.merchant]);
      }

      // ---- order: eventos (polling/ack) ----
      if (method === "GET" && pathname === "/order/v1.0/orders:polling") {
        state.log.polledAt.push(new Date().toISOString());
        if (state.pendingEvents.length === 0) return send(res, 204);
        return send(res, 200, { events: state.pendingEvents });
      }
      if (method === "POST" && pathname === "/order/v1.0/orders:acknowledgment") {
        const body = (await json()) as { acknowledgedEventIds?: string[] };
        const ids = body?.acknowledgedEventIds ?? [];
        state.log.acked.push(...ids);
        state.pendingEvents = state.pendingEvents.filter((e) => !ids.includes(e.id));
        return send(res, 202, { status: "ACCEPTED" });
      }

      // ---- order: detalhe + ações por orderId -
      const orderAction = pathname.match(/^\/order\/v1\.0\/orders\/([^/]+)\/(confirm|startPreparation|readyToPickup|dispatch|requestCancellation|acceptCancellation|denyCancellation)$/);
      if (orderAction) {
        const [, orderId, action] = orderAction;
        const body = (await json()) as Record<string, unknown> | null;
        switch (action) {
          case "confirm":
            state.log.confirms.push(orderId);
            break;
          case "startPreparation":
            state.log.startPreparation.push(orderId);
            break;
          case "readyToPickup":
            state.log.readyToPickup.push(orderId);
            break;
          case "dispatch":
            state.log.dispatched.push(orderId);
            break;
          case "requestCancellation":
            state.log.cancellations.push({ orderId, reason: (body?.reason as string) ?? undefined });
            break;
          default:
            log(`order ${action}`, orderId);
        }
        return send(res, 202, { status: "ACCEPTED" });
      }
      const orderDetail = pathname.match(/^\/order\/v1\.0\/orders\/([^/]+)$/);
      if (orderDetail) {
        const orderId = orderDetail[1];
        state.log.ordersFetched.push(orderId);
        const order = state.orders[orderId];
        if (!order) return send(res, 404, { code: "NOT_FOUND" });
        return send(res, 200, order);
      }

      // ---- catalog ----
      if (method === "GET" && pathname.match(/^\/catalog\/v2\.0\/merchants\/[^/]+\/catalogs$/)) {
        log("listCatalogs");
        return send(res, 200, [{ catalogId: state.catalogId, context: ["DEFAULT"], status: "AVAILABLE" }]);
      }
      if (method === "GET" && pathname.match(/^\/catalog\/v2\.0\/merchants\/[^/]+\/catalogs\/[^/]+\/categories$/)) {
        log("listCategories");
        return send(res, 200, state.categories);
      }
      if (method === "POST" && pathname.match(/^\/catalog\/v2\.0\/merchants\/[^/]+\/catalogs\/[^/]+\/categories$/)) {
        const body = (await json()) as { name?: string } | null;
        const category = { id: `cat-mock-${state.categories.length + 1}`, name: body?.name ?? "Categoria" };
        state.categories.push(category);
        log("createCategory", category.name);
        return send(res, 200, category);
      }
      if (method === "PUT" && pathname.match(/^\/catalog\/v2\.0\/merchants\/[^/]+\/items$/)) {
        const body = (await json()) as { items?: Array<{ id?: string }> } | null;
        const items = Array.isArray(body?.items) ? body.items : [];
        state.items.push(...items);
        const ids = items.map((it) => it.id ?? "mock-item");
        log("upsertItem", `${ids.length} itens`);
        return send(res, 200, { ids: ids.map((id) => ({ id })) });
      }

      // fallback: registra e responde vazio
      log(`unhandled ${method} ${pathname}`);
      return send(res, 404, { code: "NOT_FOUND" });
    } catch (err) {
      return send(res, 500, { code: "INTERNAL", message: String(err) });
    }
  });

  server.on("listening", () => {
    console.log(`[ifood.mock] mock da API iFood em http://localhost:${ifoodConfig.mockPort}`);
    // marca mock no estado pra status no painel do gerente
    setIfoodState("mockMode", "true");
    setIfoodState(ifoodStateKeys.merchantId, state.merchant.id);
    setIfoodState(ifoodStateKeys.merchantName, state.merchant.name);
  });

  server.listen(ifoodConfig.mockPort, "127.0.0.1");
  return server;
}