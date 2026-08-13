import type { WebSocket } from "ws";

interface Connection {
  socket: WebSocket;
  rooms: Set<string>;
}

export class WsGateway {
  private connections = new Set<Connection>();

  addConnection(socket: WebSocket, initialRooms: string[]) {
    const conn: Connection = { socket, rooms: new Set(initialRooms) };
    this.connections.add(conn);
    socket.on("close", () => this.connections.delete(conn));
    return conn;
  }

  joinRoom(conn: Connection, room: string) {
    conn.rooms.add(room);
  }

  broadcastToRoom(room: string, event: { type: string; payload: unknown; correlationId?: string }) {
    const message = JSON.stringify({ ...event, emittedAt: new Date().toISOString() });
    for (const conn of this.connections) {
      if (conn.rooms.has(room) && conn.socket.readyState === conn.socket.OPEN) {
        conn.socket.send(message);
      }
    }
  }
}

export const wsGateway = new WsGateway();
