// Novo: teste do client HTTP RN com `fetch` mockado. Cobre o que o contrato
// do web mantém (Bearer/401 global/204/erro estruturado) e as duas diferenças
// do app nativo (fetch global, sem CORS; pingApi sem servidor → false).
import { pingApi, request, setAuthToken, setUnauthorizedHandler } from "./http.js";
import { setAppConfig } from "@/shared/lib";

function jsonResponse(status, payload, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: async () => payload,
  };
}

describe("http request", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    setAppConfig({ apiBase: "http://10.0.2.2:3000", daemonUrl: "" });
    setAuthToken(null);
    setUnauthorizedHandler(null);
    global.fetch = jest.fn(async () => jsonResponse(200, {}));
  });

  afterEach(() => {
    setAppConfig(null);
    global.fetch = originalFetch;
  });

  it("manda Authorization: Bearer quando há token", async () => {
    setAuthToken("jwt-123");
    await request("GET", "/orders");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.2.2:3000/api/orders",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-123" }),
      }),
    );
  });

  it("serializa o corpo em JSON com Content-Type", async () => {
    await request("POST", "/auth/login", { userId: "u1", pin: "1234" });
    const [, init] = global.fetch.mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ userId: "u1", pin: "1234" }));
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.method).toBe("POST");
  });

  it("dispara o handler global de 401", async () => {
    const onUnauthorized = jest.fn();
    setUnauthorizedHandler(onUnauthorized);
    global.fetch.mockResolvedValue(jsonResponse(401, { error: { code: "invalid_token", message: "token inválido" } }));
    await expect(request("GET", "/orders")).rejects.toThrow("token inválido");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("devolve null em 204", async () => {
    global.fetch.mockResolvedValue(jsonResponse(204, null));
    await expect(request("DELETE", "/orders/o1/items/i1")).resolves.toBe(null);
  });

  it("devolve o payload JSON em 2xx", async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, { ok: true, data: [1, 2] }));
    await expect(request("GET", "/orders")).resolves.toEqual({ ok: true, data: [1, 2] });
  });

  it("estrutura o erro com message/code/status/details", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse(400, { error: { code: "invalid_pin", message: "PIN incorreto", details: { pin: "curto" } } }),
    );
    const error = await request("GET", "/orders").then(
      () => null,
      (e) => e,
    );
    expect(error.message).toBe("PIN incorreto");
    expect(error.code).toBe("invalid_pin");
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ pin: "curto" });
  });
});

describe("pingApi", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    setAppConfig(null);
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("true quando /health responde ok", async () => {
    setAppConfig({ apiBase: "http://10.0.2.2:3000" });
    global.fetch = jest.fn(async () => jsonResponse(200, { tag: "v1.26.0" }));
    await expect(pingApi()).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledWith("http://10.0.2.2:3000/health", expect.anything());
  });

  it("false quando o servidor responde erro", async () => {
    setAppConfig({ apiBase: "http://10.0.2.2:3000" });
    global.fetch = jest.fn(async () => jsonResponse(503, {}));
    await expect(pingApi()).resolves.toBe(false);
  });

  it("false quando o fetch falha (rede fora)", async () => {
    setAppConfig({ apiBase: "http://10.0.2.2:3000" });
    global.fetch = jest.fn(async () => {
      throw new Error("Network request failed");
    });
    await expect(pingApi()).resolves.toBe(false);
  });

  it("false sem servidor configurado (sem fetch — setup bloqueia)", async () => {
    setAppConfig(null);
    global.fetch = jest.fn();
    await expect(pingApi()).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("false quando estoura o timeout (Promise.race)", async () => {
    jest.useFakeTimers();
    setAppConfig({ apiBase: "http://10.0.2.2:3000" });
    global.fetch = jest.fn(() => new Promise(() => {})); // nunca resolve
    const promise = pingApi(50);
    jest.advanceTimersByTime(60);
    await expect(promise).resolves.toBe(false);
    jest.useRealTimers();
  });
});