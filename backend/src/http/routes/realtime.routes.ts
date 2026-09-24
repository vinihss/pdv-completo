import type { FastifyInstance } from "fastify";
import { verifyTokenRaw } from "../middlewares/auth.middleware.js";
import { wsGateway } from "../../infra/realtime/ws-gateway.js";

export async function realtimeRoutes(app: FastifyInstance) {
  app.get("/realtime", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    let authUser;
    try {
      authUser = token ? verifyTokenRaw(token) : null;
    } catch {
      authUser = null;
    }
    if (!authUser) {
      socket.close(4001, "unauthorized");
      return;
    }

    // Rooms iniciais por perfil — o client também pode entrar em `table:{id}` específico via mensagem.
    const initialRooms = [`waiter:${authUser.sub}`];
    if (authUser.role === "kitchen") initialRooms.push("kitchen-display");
    // Caixa e gerente acompanham o fluxo de caixa ao vivo (pagamentos em
    // dinheiro também são broadcast para esse room — ver order.usecases).
    if (authUser.role === "cashier" || authUser.role === "manager") initialRooms.push("cash-drawer");

    const conn = wsGateway.addConnection(socket as any, initialRooms);

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "join" && typeof msg.room === "string") {
          wsGateway.joinRoom(conn, msg.room);
        }
        // sync.request (§8) — implementação mínima: sem buffer de eventos perdidos
        // nesta etapa, o client deve refazer um GET pra recarregar o estado atual
        // ao reconectar; respondemos vazio pra não travar o client esperando.
        if (msg.type === "sync.request") {
          socket.send(JSON.stringify({ type: "sync.response", payload: { events: [] }, emittedAt: new Date().toISOString() }));
        }
      } catch {
        // mensagem malformada — ignora
      }
    });
  });
}
