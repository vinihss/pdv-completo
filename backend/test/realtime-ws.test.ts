// Smoke do hook `onRoute` sobre handlers de WebSocket.
//
// O hook envolve todo handler com `ensureTenantScope`. Um handler de websocket
// recebe (socket, request) — NÃO (request, reply) — e `socket.headers` é
// undefined. Sem tratar esse caso à parte, o wrapper estoura no handshake e
// derruba o `/realtime`. Este teste sobe o app num socket real e conecta um
// cliente `ws` em `/realtime/public`, confirmando que o handler roda.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { closeTestApp, seedFixture, testApp } from "./helpers.js";

describe("onRoute + websocket", () => {
  let close: () => Promise<void>;

  beforeAll(async () => {
    await seedFixture();
    const app = await testApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    await closeTestApp();
  });

  it("/realtime/public abre o handshake e o handler responde join.denied", async () => {
    const app = await testApp();
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime/public`, {
      headers: { host: "localhost:3000" },
    });

    const msg = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout esperando resposta do WS")), 8000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "join", room: "not-a-room" })));
      ws.on("message", (raw: Buffer) => {
        clearTimeout(timer);
        resolve(raw.toString());
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(JSON.parse(msg).type).toBe("join.denied");
    ws.close();
  });
});
