import type { FastifyInstance } from "fastify";
import { verifyTokenRaw, type AuthUser } from "../middlewares/auth.middleware.js";
import { wsGateway } from "../../infra/realtime/ws-gateway.js";

// 2.3 — autorização dos rooms dinâmicos (mensagem `join`). Os rooms iniciais
// de cada perfil já são definidos no connect; aqui só se garante que um client
// autenticado não entra em room alheio (ex: garçom assinando `deliveries` de
// outro canal, ou qualquer um bisbilhotando `cash-drawer`).
function canJoinRoom(user: AuthUser, room: string): boolean {
  const { sub, role } = user;
  if (room === `waiter:${sub}`) return true;
  // Central de alertas: o room público (`alerts`, alerta sem restrição de
  // público) e o room do PRÓPRIO papel. Autorizar o próprio e não "o room de
  // qualquer papel" é o que impede o garçom de assinar `alerts:manager` e
  // ouvir a comanda que ele não deveria — é o mesmo recorte que o
  // `audience_roles` faz no REST (alert.usecases.ts).
  if (room === "alerts" || room === `alerts:${role}`) return true;
  switch (role) {
    case "waiter":
      return room === "kitchen-display" || room === "deliveries";
    case "manager":
      // `whatsapp` = status de entrega/leitura das mensagens enviadas,
      // publicado pelo webhook `messages.statuses` (whatsapp.usecases.ts).
      return (
        room === "kitchen-display" ||
        room === "deliveries" ||
        room === "cash-drawer" ||
        room === "inventory" ||
        room === "whatsapp"
      );
    case "kitchen":
      return room === "kitchen-display";
    case "cashier":
      return room === "cash-drawer";
    case "courier":
      return room === "deliveries";
    default:
      return false;
  }
}

export async function realtimeRoutes(app: FastifyInstance) {
  app.get("/realtime", { websocket: true }, (socket, req) => {
    // 2.3 — token via subprotocol (Sec-WebSocket-Protocol), não na query string
    // (que vaza em logs de proxy). O client chama new WebSocket(url, [token]);
    // o ws aceita o primeiro protocolo oferecido e o reflete no handshake.
    const offered = String(req.headers["sec-websocket-protocol"] ?? "");
    const token = offered.split(",")[0]?.trim();

    let authUser: AuthUser | null = null;
    try {
      authUser = token ? verifyTokenRaw(token) : null;
    } catch {
      authUser = null;
    }
    if (!authUser) {
      socket.close(4001, "unauthorized");
      return;
    }

    // Rooms iniciais por perfil — o client também pode entrar em outros rooms
    // permitidos do seu papel via mensagem `join`.
    const initialRooms = [`waiter:${authUser.sub}`];
    if (authUser.role === "kitchen") initialRooms.push("kitchen-display");
    // Caixa e gerente acompanham o fluxo de caixa ao vivo (pagamentos em
    // dinheiro também são broadcast para esse room — ver order.usecases).
    if (authUser.role === "cashier" || authUser.role === "manager") initialRooms.push("cash-drawer");
    // Gerente acompanha o estoque ao vivo (movimentos e alertas de estoque baixo).
    if (authUser.role === "manager") initialRooms.push("inventory");
    // O sino da casca (todos os perfis) — o client também pede esses dois via
    // `join`, mas vir aqui evita a ida-e-volta e garante o alerta no primeiro
    // evento depois do login, sem depender do hook montado.
    initialRooms.push("alerts", `alerts:${authUser.role}`);

    const conn = wsGateway.addConnection(socket as any, initialRooms);

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "join" && typeof msg.room === "string") {
          if (canJoinRoom(authUser!, msg.room)) {
            wsGateway.joinRoom(conn, msg.room);
          } else {
            socket.send(JSON.stringify({ type: "join.denied", room: msg.room }));
          }
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

  // ---------- WS público (máquina de estado do cliente) ----------
  // Acompanhamento da tela de confirmação (/pedido) sem JWT — o client
  // anônimo entra em `order:<orderId>` via mensagem join; o UUID é a
  // "senha" de fato (só quem tem o orderId acompanha — mesmo modelo de
  // confiança do GET /public/orders/:id/status). Join é restrito a rooms
  // `order:<uuid>`: nenhum room interno (cash-drawer, deliveries, ...)
  // é alcançável por cliente anônimo.
  app.get("/realtime/public", { websocket: true }, (socket) => {
    const ORDER_ROOM_RE = /^order:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const conn = wsGateway.addConnection(socket as any, []);

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "join" && typeof msg.room === "string" && ORDER_ROOM_RE.test(msg.room)) {
          wsGateway.joinRoom(conn, msg.room);
          return;
        }
        if (msg.type === "join") {
          socket.send(JSON.stringify({ type: "join.denied", room: msg.room }));
          return;
        }
        if (msg.type === "sync.request") {
          // Sem buffer de eventos perdidos: o client refaz o GET de status
          // ao reconectar (mesmo padrão dos clients autenticados).
          socket.send(JSON.stringify({ type: "sync.response", payload: { events: [] }, emittedAt: new Date().toISOString() }));
        }
      } catch {
        // mensagem malformada — ignora
      }
    });
  });
}