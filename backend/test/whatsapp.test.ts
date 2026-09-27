import http from "node:http";
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, manager, raw, resetState, seedFixture, testApp, waiter } from "./helpers.js";

/**
 * Embedded Signup / WhatsApp Cloud API.
 *
 * A Graph API real é substituída por um stub HTTP local. A URL dele vem do
 * `env` do vitest.config (porta fixa 3455) porque `src/config/env.ts` é um
 * snapshot feito no load do módulo — se a URL fosse ajustada no beforeAll
 * desta suíte, ela já estaria congelada. As credenciais de teste
 * (META_APP_ID/SECRET) vêm do mesmo lugar, e é contra elas que a assinatura
 * do webhook e o appsecret_proof são conferidos — o stub não aceita valor
 * mágico, ele recalcula o HMAC.
 *
 * O que esta suíte protege, por ordem de importância:
 *  - fan-out do payload: a versão anterior lia entry[0].changes[0]…messages[0]
 *    e descartava o resto do lote em silêncio;
 *  - dedupe por wamid: a Meta reenvia o mesmo webhook até receber 200;
 *  - assinatura do webhook: sem ela o PDV aceitaria mensagem forjada;
 *  - a ordem do onboarding (register antes de subscribed_apps) e o
 *    appsecret_proof em toda chamada autenticada.
 */

const APP_ID = "app-123";
const APP_SECRET = "app-secret-de-teste";
const SIGNUP_CONFIG_ID = "cfg-123";
const VERIFY_TOKEN = "verify-me";
const STUB_PORT = 3455;
const GRAPH_VERSION = "v99.0";
const WABA_ID = "waba-1";
const PHONE_ID = "phone-1";
const CLIENT_TOKEN = "business-token-xyz";
const OUT_WAMID = "wamid.out-1";

interface GraphCall {
  method: string;
  path: string;
  auth?: string;
  proof?: string;
  body?: any;
}

let server: http.Server;
let calls: GraphCall[] = [];

// knobs por teste
let phoneNumbers: Array<{
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;
}>;
let grantedScopes: Array<{ scope: string; target_ids: string[] }>;
let codeExchangeFails: boolean;
let registerFails: boolean;
let numbersCallFails: boolean;

function resetGraph() {
  calls = [];
  phoneNumbers = [
    {
      id: PHONE_ID,
      display_phone_number: "+55 51 99999-0000",
      verified_name: "Unami Sushi",
      quality_rating: "GREEN",
    },
  ];
  grantedScopes = [
    { scope: "whatsapp_business_management", target_ids: [WABA_ID] },
    { scope: "whatsapp_business_messaging", target_ids: [WABA_ID] },
  ];
  codeExchangeFails = false;
  registerFails = false;
  numbersCallFails = false;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function graphError(res: http.ServerResponse, message: string, code = 100) {
  json(res, 400, {
    error: { message, type: "OAuthException", code, fbtrace_id: "trace-1" },
  });
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Tira o /v99.0 do path para o roteamento do stub ficar legível.
    const path = url.pathname.replace(new RegExp(`^/${GRAPH_VERSION}`), "");
    const body = await readBody(req);
    calls.push({
      method: req.method ?? "GET",
      path,
      auth: req.headers.authorization as string | undefined,
      proof: req.headers["appsecret_proof"] as string | undefined,
      body,
    });

    // ---------- code -> token do cliente ----------
    if (path === "/oauth/access_token") {
      if (codeExchangeFails) return graphError(res, "Error validating verification code.");
      return json(res, 200, { access_token: CLIENT_TOKEN, token_type: "bearer" });
    }

    // ---------- introspecção: escopos e target_ids ----------
    if (path === "/debug_token") {
      return json(res, 200, {
        data: { app_id: APP_ID, granular_scopes: grantedScopes, expires_at: 0 },
      });
    }

    // ---------- números da WABA ----------
    if (path === `/${WABA_ID}/phone_numbers`) {
      if (numbersCallFails) return graphError(res, "Unsupported get request.", 803);
      return json(res, 200, { data: phoneNumbers });
    }

    // ---------- perfil do negócio (best effort) ----------
    if (path === `/${WABA_ID}/business_profile`) {
      return json(res, 200, { data: [{ about: "Sushi e temakeria", vertical: "RESTAURANT" }] });
    }

    // ---------- portfolio: id do business dono da WABA ----------
    if (path === `/${WABA_ID}`) {
      return json(res, 200, { id: WABA_ID, business: { id: "biz-1" } });
    }

    // ---------- registra o número na Cloud API ----------
    if (path === `/${PHONE_ID}/register`) {
      if (registerFails) return graphError(res, "Phone number not registered", 131026);
      return json(res, 200, { success: true });
    }

    // ---------- assina nosso app nos webhooks da WABA ----------
    if (path === `/${WABA_ID}/subscribed_apps`) {
      return json(res, 200, { success: true });
    }

    // ---------- envio ----------
    if (path === `/${PHONE_ID}/messages`) {
      return json(res, 200, { messages: [{ id: OUT_WAMID }] });
    }

    graphError(res, `caminho inesperado: ${path}`, 404);
  });

  // A porta tem que ser a mesma do vitest.config, senão a URL do config
  // aponta para o lugar nenhum.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await seedFixture();
  await resetState();
  resetGraph();
});

function signature(body: string): string {
  return (
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")
  );
}

function appSecretProof(): string {
  return crypto.createHmac("sha256", APP_SECRET).update(CLIENT_TOKEN, "utf8").digest("hex");
}

async function postWebhook(payload: unknown, opts: { sign?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const res = await (await testApp()).inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: {
      "content-type": "application/json",
      ...(opts.sign === false ? {} : { "x-hub-signature-256": signature(body) }),
    },
    payload: body,
  });
  return res;
}

/** Payload de uma mensagem, com o metadata que a Meta manda de verdade. */
function metaPayload(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { display_phone_number: "+55 51 99999-0000", phone_number_id: PHONE_ID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

function connect(over: Record<string, unknown> = {}) {
  return api("post", "/whatsapp/embedded-signup/exchange", {
    token: manager,
    body: {
      // O code real da Meta é uma string opaca bem longa; o schema exige
      // no mínimo 10 chars.
      code: "EAA-code-de-teste-valido-123456",
      wabaId: WABA_ID,
      phoneNumberId: PHONE_ID,
      businessId: "biz-1",
      businessName: "Unami",
      ...over,
    },
  });
}

/**
 * O webhook responde 200 antes de processar (a Meta reenvia por ~7 dias se
 * não receber 200 rápido), então as usecases rodam fire-and-forget.
 *
 * `setImmediate` não serve aqui: ele só drena a fila de microtask/immediate,
 * e as queries de status batem no Postgres de verdade (I/O de socket). O
 * jeito é POLTEAR a condição, com prazo. Sem isso o teste afirma sobre a DB
 * antes de a promise acabar e falha com o status antigo — flaky na maioria
 * das vezes verde, vermelho na CI.
 */
async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 4000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`timeout esperando: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const statusOf = (wamid: string) => async () => {
  const row = await raw.get("select status from whatsapp_outbound_message where id = $1", [wamid]);
  return row?.status !== undefined && row.status !== "sent";
};

const pathsOf = () => calls.map((c) => c.path);

// ============================================================
describe("WhatsApp — Embedded Signup", () => {
  describe("estado da conexão", () => {
    it("oferece o botão só com app id, secret e config id presentes", async () => {
      const { getWhatsAppStatusUsecase } = await import(
        "../src/application/whatsapp/whatsapp.usecases.js"
      );
      const status = await getWhatsAppStatusUsecase();
      expect(status.canConnect).toBe(true);
      expect(status.missing).toEqual([]);
      expect(status.connected).toBe(false);
      expect(status.connection).toBeNull();
    });

    it("nunca expõe o access token, nem depois de conectado", async () => {
      const { getWhatsAppStatusUsecase } = await import(
        "../src/application/whatsapp/whatsapp.usecases.js"
      );
      await connect();
      const status = await getWhatsAppStatusUsecase();
      expect(status.connected).toBe(true);
      expect(status.connection?.displayPhoneNumber).toBe("+55 51 99999-0000");
      expect(status.connection?.phoneNumberId).toBe(PHONE_ID);
      // O token é da WABA do cliente: não tem motivo para sair do servidor.
      expect(JSON.stringify(status)).not.toContain(CLIENT_TOKEN);
    });

    it("GET /whatsapp/config devolve só o que o browser precisa (app id e config id)", async () => {
      const res = await api("get", "/whatsapp/config", { token: manager });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        appId: APP_ID,
        configId: SIGNUP_CONFIG_ID,
        graphVersion: GRAPH_VERSION,
        canConnect: true,
      });
      expect(JSON.stringify(res.json)).not.toContain(APP_SECRET);
    });

    it("as rotas são só do gerente", async () => {
      expect((await api("get", "/whatsapp/status", { token: waiter })).status).toBe(403);
      expect((await api("get", "/whatsapp/status", { token: manager })).status).toBe(200);
    });
  });

  describe("troca do code pelo token da WABA", () => {
    it("troca, valida escopos, registra o número e assina os webhooks", async () => {
      const res = await connect();
      expect(res.status).toBe(200);
      expect(res.json.steps).toEqual({
        exchanged: true,
        scopesValidated: true,
        phoneResolved: true,
        registered: true,
        webhooksSubscribed: true,
      });
      expect(res.json.phoneNumberId).toBe(PHONE_ID);
    });

    it("registra o número ANTES de assinar os webhooks", async () => {
      await connect();
      const paths = pathsOf();
      const registerAt = paths.indexOf(`/${PHONE_ID}/register`);
      const subscribeAt = paths.indexOf(`/${WABA_ID}/subscribed_apps`);
      expect(registerAt).toBeGreaterThan(-1);
      expect(subscribeAt).toBeGreaterThan(-1);
      // Sem o register, o envio falha com 803; sem o subscribe, o envio
      // funciona mas a resposta do cliente nunca chega (o bug mais confuso
      // possível de diagnosticar).
      expect(registerAt).toBeLessThan(subscribeAt);
    });

    it("manda appsecret_proof em toda chamada autenticada com o token do cliente", async () => {
      await connect();
      const authenticated = calls.filter((c) => c.auth === `Bearer ${CLIENT_TOKEN}`);
      expect(authenticated.length).toBeGreaterThan(0);
      for (const c of authenticated) {
        expect(c.proof).toBe(appSecretProof());
      }
    });

    it("descobre o phone_number_id quando o postMessage não traz", async () => {
      // phoneNumberId ausente é caso real: a Meta omite o campo em alguns
      // caminhos do Embedded Signup.
      const res = await connect({ phoneNumberId: null });
      expect(res.status).toBe(200);
      expect(res.json.phoneNumberId).toBe(PHONE_ID);
      expect(pathsOf()).toContain(`/${WABA_ID}/phone_numbers`);
    });

    it("usa a waba_id do token quando o postMessage não traz", async () => {
      const res = await connect({ wabaId: null });
      expect(res.status).toBe(200);
      expect(res.json.wabaId).toBe(WABA_ID);
    });

    it("rejeita quando falta o escopo de envio, dizendo qual falta", async () => {
      grantedScopes = [{ scope: "whatsapp_business_management", target_ids: [WABA_ID] }];
      const res = await connect();
      expect(res.status).toBe(422);
      expect(res.json.error.code).toBe("whatsapp_missing_scopes");
      expect(res.json.error.details.missing).toEqual(["whatsapp_business_messaging"]);
    });

    it("code inválido vira erro de domínio, não 500", async () => {
      codeExchangeFails = true;
      const res = await connect();
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("whatsapp_invalid_code");
    });

    it("erro da Meta no register não deixa conexão salva pela metade", async () => {
      registerFails = true;
      const res = await connect();
      // 5xx de provider: o cliente precisa saber que foi a Meta, e o estado
      // não pode fingir que conectou.
      expect(res.status).toBe(502);
      const row = await raw.get("select count(*)::int as n from whatsapp_connection");
      expect(row.n).toBe(0);
    });

    it("grava a conexão e o audit log", async () => {
      await connect();
      const conn = await raw.get(
        "select waba_id, phone_number_id, display_phone_number, display_name, business_id from whatsapp_connection"
      );
      expect(conn).toMatchObject({
        waba_id: WABA_ID,
        phone_number_id: PHONE_ID,
        display_phone_number: "+55 51 99999-0000",
        // verified_name da Meta tem precedência sobre o `about` do perfil.
        display_name: "Unami Sushi",
        business_id: "biz-1",
      });
      const audit = await raw.get(
        "select user_id from audit_log where action = 'whatsapp_connected'"
      );
      expect(audit?.user_id).toBe("u-manager");
    });

    it("reconectar a mesma WABA atualiza a linha em vez de duplicar", async () => {
      await connect();
      await connect();
      const rows = await raw.all("select waba_id, access_token from whatsapp_connection");
      expect(rows.length).toBe(1);
      const counts = await raw.all(
        "select action, count(*)::int as n from audit_log where action like 'whatsapp_%' group by action"
      );
      const byAction = Object.fromEntries(counts.map((r) => [r.action, Number(r.n)]));
      expect(byAction.whatsapp_connected).toBe(1);
      expect(byAction.whatsapp_reconnected).toBe(1);
    });

    it("exige code com pelo menos 10 caracteres", async () => {
      const res = await connect({ code: "curto" });
      expect(res.status).toBe(400);
    });
  });

  describe("desconectar", () => {
    it("marca como desconectado e audita", async () => {
      await connect();
      const res = await api("post", "/whatsapp/disconnect", { token: manager });
      expect(res.status).toBe(200);
      expect(res.json.disconnected).toBe(true);
      const row = await raw.get("select status from whatsapp_connection");
      expect(row.status).toBe("disconnected");
      const audit = await raw.get(
        "select count(*)::int as n from audit_log where action = 'whatsapp_disconnected'"
      );
      expect(Number(audit.n)).toBe(1);
    });

    it("não quebra quando não há nada conectado", async () => {
      const res = await api("post", "/whatsapp/disconnect", { token: manager });
      expect(res.status).toBe(200);
      expect(res.json.disconnected).toBe(false);
    });
  });

  describe("webhook — handshake e assinatura", () => {
    it("responde 200 com o challenge no handshake certo", async () => {
      const res = await (await testApp()).inject({
        method: "GET",
        url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
      });
      // A Meta exige o challenge como valor cru, não JSON.
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("12345");
    });

    it("recusa o handshake com verify token errado", async () => {
      const res = await (await testApp()).inject({
        method: "GET",
        url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1",
      });
      expect(res.statusCode).toBe(403);
    });

    it("recusa payload sem assinatura válida com 401", async () => {
      const res = await postWebhook(metaPayload({ messages: [] }), { sign: false });
      expect(res.statusCode).toBe(401);
    });

    it("recusa assinatura feita com o segredo errado", async () => {
      const body = JSON.stringify(metaPayload({ messages: [] }));
      const res = await (await testApp()).inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256":
            "sha256=" + crypto.createHmac("sha256", "outro-segredo").update(body).digest("hex"),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("webhook — fan-out do lote", () => {
    it("processa todas as mensagens de entry x changes x messages", async () => {
      await connect();

      // Regressão do bug antigo: entry[0].changes[0].value.messages[0]
      // descartava o resto do lote sem erro e sem log.
      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: WABA_ID,
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: PHONE_ID },
                  messages: [
                    { id: "wamid.a", from: "5511900000001", type: "text", text: { body: "oi" } },
                    { id: "wamid.b", from: "5511900000002", type: "text", text: { body: "olá" } },
                  ],
                },
              },
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: PHONE_ID },
                  messages: [
                    {
                      id: "wamid.c",
                      from: "5511900000003",
                      type: "location",
                      location: { latitude: -29.7542, longitude: -51.1496 },
                    },
                  ],
                },
              },
            ],
          },
          {
            id: WABA_ID,
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: PHONE_ID },
                  messages: [
                    { id: "wamid.d", from: "5511900000004", type: "text", text: { body: "pedido" } },
                  ],
                },
              },
            ],
          },
        ],
      };

      const res = await postWebhook(payload);
      expect(res.statusCode).toBe(200);

      // Todas as 4 precisam ter sido reservadas no dedupe.
      await waitFor("as 4 mensagens do lote", async () => {
        const rows = await raw.all("select id from whatsapp_inbound_message order by id");
        return rows.length === 4;
      });
      const rows = await raw.all("select id from whatsapp_inbound_message order by id");
      expect(rows.map((r) => r.id)).toEqual(["wamid.a", "wamid.b", "wamid.c", "wamid.d"]);
    });

    it("dedupe: o mesmo wamid reenviado pela Meta processa uma vez só", async () => {
      await connect();
      const payload = metaPayload({
        messages: [{ id: "wamid.dup", from: "5511900000009", type: "text", text: { body: "oi" } }],
      });

      await postWebhook(payload);
      await waitFor("primeira reserva do wamid", async () => {
        return (await raw.all("select id from whatsapp_inbound_message")).length === 1;
      });

      // Reenvios: a Meta repete o MESMO webhook até receber 200.
      await postWebhook(payload);
      await postWebhook(payload);

      const rows = await raw.all("select id from whatsapp_inbound_message where id = 'wamid.dup'");
      expect(rows.length).toBe(1);
    });

    it("responde 200 e ignora quando a WABA não está conectada", async () => {
      const res = await postWebhook(
        metaPayload({
          messages: [{ id: "wamid.z", from: "5511900000000", type: "text", text: { body: "oi" } }],
        })
      );
      // 4xx/5xx aqui faria a Meta reenviar por ~7 dias um payload que nunca
      // vai ser processável.
      expect(res.statusCode).toBe(200);
      // Dá tempo do fire-and-forget rodar para confirmar que ele também não
      // processou nada.
      await new Promise((r) => setTimeout(r, 200));
      const rows = await raw.all("select id from whatsapp_inbound_message");
      expect(rows.length).toBe(0);
    });

    it("não manda mensagem de uma WABA desconhecida na WABA ativa", async () => {
      // Duas instalações podem compartilhar o mesmo app secret e, portanto,
      // o mesmo webhook. Cair para a conexão ativa responderia na WABA errada.
      await connect();
      calls = [];
      await postWebhook({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba-de-outra-instalacao",
            changes: [
              {
                field: "messages",
                value: {
                  // phone_number_id que NÃO é o nosso.
                  metadata: { phone_number_id: "phone-de-outra" },
                  messages: [
                    { id: "wamid.de-outra", from: "5511900000010", type: "text", text: { body: "oi" } },
                  ],
                },
              },
            ],
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 200));

      const inbound = await raw.all("select id from whatsapp_inbound_message");
      expect(inbound.length).toBe(0);
      expect(calls.some((c) => c.path.endsWith("/messages"))).toBe(false);
    });

    it("cai na conexão ativa quando o payload não traz metadata", async () => {
      // Sem phone_number_id não dá para escolher por WABA — mas só há uma
      // conexão ativa por instalação, então a mensagem é mesmo nossa.
      await connect();
      await postWebhook({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  messages: [
                    { id: "wamid.sem-metadata", from: "5511900000012", type: "text", text: { body: "oi" } },
                  ],
                },
              },
            ],
          },
        ],
      });
      await waitFor("reserva na conexão ativa", async () => {
        return (await raw.all("select id from whatsapp_inbound_message")).length === 1;
      });
      const row = await raw.get("select waba_id from whatsapp_inbound_message");
      expect(row.waba_id).toBe(WABA_ID);
    });

    it("marca a conexão como expirada quando o token venceu", async () => {
      await connect();
      await raw.exec("update whatsapp_connection set token_expires_at = '2000-01-01T00:00:00.000Z'");
      const res = await postWebhook(
        metaPayload({
          messages: [{ id: "wamid.exp", from: "5511900000011", type: "text", text: { body: "oi" } }],
        })
      );
      expect(res.statusCode).toBe(200);
      await waitFor("conexão marcada como expirada", async () => {
        const r = await raw.get("select status from whatsapp_connection");
        return r?.status === "expired";
      });
      const row = await raw.get("select status, last_error from whatsapp_connection");
      expect(row.last_error).toContain("expirado");
    });
  });

  describe("webhook — status de mensagem enviada", () => {
    async function recordOutbound(wamid: string, to: string) {
      const { recordOutboundMessage } = await import("../src/integrations/whatsapp/state.js");
      await recordOutboundMessage({ wamid, wabaId: WABA_ID, toPhone: to, kind: "notification" });
    }

    function statusPayload(wamid: string, status: string, extra: Record<string, unknown> = {}) {
      return {
        object: "whatsapp_business_account",
        entry: [
          {
            id: WABA_ID,
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: PHONE_ID },
                  statuses: [{ id: wamid, status, recipient_id: "5511900000005", ...extra }],
                },
              },
            ],
          },
        ],
      };
    }

    it("aplica delivered e read, e publica no room whatsapp", async () => {
      await connect();
      await recordOutbound("wamid.enviada", "5511900000005");

      await postWebhook(statusPayload("wamid.enviada", "delivered"));
      await waitFor("delivered", statusOf("wamid.enviada"));

      await postWebhook(statusPayload("wamid.enviada", "read"));
      await waitFor("read", async () => {
        const row = await raw.get("select status from whatsapp_outbound_message where id = 'wamid.enviada'");
        return row?.status === "read";
      });

      // O gerente vê a mensagem mudar de estado sem recarregar a tela.
      const events = await raw.all(
        "select event_type, room from outbox_event where event_type = 'whatsapp.message_status' order by seq"
      );
      expect(events.length).toBe(2);
      expect(events.every((e) => e.room === "whatsapp")).toBe(true);
    });

    it("grava o motivo da falha", async () => {
      await connect();
      await recordOutbound("wamid.falha", "5511900000006");

      await postWebhook(
        statusPayload("wamid.falha", "failed", {
          errors: [{ code: 131047, message: "Re-engagement message" }],
        })
      );
      await waitFor("failed", statusOf("wamid.falha"));

      const row = await raw.get(
        "select status, error_code, error_message from whatsapp_outbound_message where id = 'wamid.falha'"
      );
      expect(Number(row.error_code)).toBe(131047);
      expect(row.error_message).toContain("Re-engagement");
    });

    it("wamid desconhecido não quebra nem vira status em mensagem nossa", async () => {
      await connect();
      const res = await postWebhook(statusPayload("wamid.de-outra-instalacao", "delivered"));
      await new Promise((r) => setTimeout(r, 200));
      expect(res.statusCode).toBe(200);
      const events = await raw.all("select count(*)::int as n from outbox_event");
      expect(Number(events[0].n)).toBe(0);
    });

    it("status que a gente não conhece não sobrescreve o conhecido", async () => {
      await connect();
      await recordOutbound("wamid.desconhecido", "5511900000007");
      await postWebhook(statusPayload("wamid.desconhecido", "delivered"));
      await waitFor("delivered", statusOf("wamid.desconhecido"));

      // Status que a gente não conhece não pode sobrescrever um conhecido.
      await postWebhook(statusPayload("wamid.desconhecido", "accepted_qui_sabe_que"));
      await new Promise((r) => setTimeout(r, 200));

      const row = await raw.get("select status from whatsapp_outbound_message where id = 'wamid.desconhecido'");
      expect(row.status).toBe("delivered");
    });
  });

  describe("envio de mensagem", () => {
    it("envia com o token da WABA e devolve o wamid", async () => {
      await connect();
      calls = [];
      const { sendTextMessage } = await import("../src/integrations/whatsapp/whatsapp.client.js");
      const sent = await sendTextMessage("5511900000008", "Seu pedido saiu!");

      expect(sent?.wamid).toBe(OUT_WAMID);
      const call = calls.find((c) => c.path === `/${PHONE_ID}/messages`);
      expect(call?.auth).toBe(`Bearer ${CLIENT_TOKEN}`);
      expect(call?.body.messaging_product).toBe("whatsapp");
    });

    it("sem conexão não faz chamada nenhuma e devolve null", async () => {
      const { sendTextMessage } = await import("../src/integrations/whatsapp/whatsapp.client.js");
      const sent = await sendTextMessage("5511900000009", "oi");
      expect(sent).toBeNull();
      expect(calls.some((c) => c.path.endsWith("/messages"))).toBe(false);
    });

    it("guarda o wamid da notificação, para o status voltar pro pedido", async () => {
      // É o que liga o "entregue" da aba do gerente a um pedido.
      await connect();
      const orderId = (
        await raw.get(
          `insert into "order" (id, status, waiter_id, table_id)
           values ('w-test-1', 'open', 'u-manager', 't-1') returning id`
        )
      ).id;

      calls = [];
      const { sendTextMessage } = await import("../src/integrations/whatsapp/whatsapp.client.js");
      const { recordOutboundMessage } = await import("../src/integrations/whatsapp/state.js");
      const sent = await sendTextMessage("5511900000010", "Seu pedido saiu para entrega!");
      expect(sent?.wamid).toBe(OUT_WAMID);
      await recordOutboundMessage({
        wamid: sent!.wamid,
        wabaId: sent!.wabaId,
        toPhone: "5511900000010",
        kind: "notification",
        orderId,
      });

      const row = await raw.get(
        "select waba_id, order_id, kind, status from whatsapp_outbound_message where id = $1",
        [OUT_WAMID]
      );
      expect(row).toMatchObject({ waba_id: WABA_ID, order_id: orderId, kind: "notification", status: "sent" });
    });
  });

  describe("histórico de mensagens", () => {
    it("GET /whatsapp/messages lista as enviadas com o status da Meta", async () => {
      await connect();
      const { recordOutboundMessage } = await import("../src/integrations/whatsapp/state.js");
      await recordOutboundMessage({
        wamid: "wamid.historico",
        wabaId: WABA_ID,
        toPhone: "5511900000011",
        kind: "bot_reply",
      });
      await postWebhook(
        {
          object: "whatsapp_business_account",
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: PHONE_ID },
                    statuses: [{ id: "wamid.historico", status: "read" }],
                  },
                },
              ],
            },
          ],
        }
      );
      await waitFor("read do histórico", async () => {
        const row = await raw.get("select status from whatsapp_outbound_message where id = 'wamid.historico'");
        return row?.status === "read";
      });

      const res = await api("get", "/whatsapp/messages", { token: manager });
      expect(res.status).toBe(200);
      expect(res.json).toHaveLength(1);
      expect(res.json[0]).toMatchObject({ id: "wamid.historico", kind: "bot_reply", status: "read" });
      expect(JSON.stringify(res.json)).not.toContain(CLIENT_TOKEN);
    });
  });
});
