import { expect } from "vitest";
import { raw } from "../helpers.js";

export interface OutboxRow {
  id: string;
  seq: number;
  room: string;
  event_type: string;
  payload: any;
  published: boolean;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  user_id: string;
  action: string;
  order_id: string | null;
  details: any;
  created_at: string;
}

function parsePayload(rawRow: any): OutboxRow {
  let parsedPayload = rawRow.payload;
  if (typeof rawRow.payload === "string") {
    try {
      parsedPayload = JSON.parse(rawRow.payload);
    } catch {
      parsedPayload = rawRow.payload;
    }
  }
  return {
    ...rawRow,
    payload: parsedPayload,
  };
}

/**
 * Retorna todos os eventos do outbox, opcionalmente filtrados por room.
 */
export async function getOutboxEvents(room?: string): Promise<OutboxRow[]> {
  let rows: any[];
  if (room) {
    rows = await raw.all(
      `SELECT id, seq, room, event_type, payload, published, created_at FROM outbox_event WHERE room = $1 ORDER BY seq`,
      [room],
    );
  } else {
    rows = await raw.all(
      `SELECT id, seq, room, event_type, payload, published, created_at FROM outbox_event ORDER BY seq`,
    );
  }
  return rows.map(parsePayload);
}

/**
 * Retorna a lista de tipos de evento emitidos para um determinado room.
 */
export async function getOutboxEventTypes(room: string): Promise<string[]> {
  const events = await getOutboxEvents(room);
  return events.map((e) => e.event_type);
}

/**
 * Valida que um determinado evento foi publicado para um room no outbox.
 */
export async function expectOutboxEvent(
  room: string,
  eventType: string,
  predicate?: (event: OutboxRow) => boolean,
): Promise<OutboxRow> {
  const events = await getOutboxEvents(room);
  const matching = events.filter((e) => e.event_type === eventType);

  expect(
    matching.length,
    `Esperava evento '${eventType}' no room '${room}'. Eventos encontrados: [${events.map((e) => e.event_type).join(", ")}]`,
  ).toBeGreaterThan(0);

  if (predicate) {
    const passed = matching.find(predicate);
    expect(passed, `Evento '${eventType}' encontrado no room '${room}', mas o predicado falhou`).toBeDefined();
    return passed!;
  }

  return matching[0];
}

/**
 * Retorna logs de auditoria, opcionalmente filtrados por action.
 */
export async function getAuditLogs(action?: string): Promise<AuditLogRow[]> {
  if (action) {
    return (await raw.all(
      `SELECT id, user_id, action, order_id, details, created_at FROM audit_log WHERE action = $1 ORDER BY created_at`,
      [action],
    )) as AuditLogRow[];
  }
  return (await raw.all(
    `SELECT id, user_id, action, order_id, details, created_at FROM audit_log ORDER BY created_at`,
  )) as AuditLogRow[];
}

/**
 * Valida que uma resposta HTTP da API contém o status e código de erro esperados.
 */
export function expectApiError(
  res: { status: number; json: any },
  expectedStatus: number,
  expectedCode: string,
) {
  expect(res.status, `Status retornado foi ${res.status} com body ${JSON.stringify(res.json)}`).toBe(expectedStatus);
  expect(res.json?.error?.code).toBe(expectedCode);
}

/**
 * Valida sucesso na chamada da API com status esperado.
 */
export function expectApiSuccess(
  res: { status: number; json: any },
  expectedStatus: number = 200,
) {
  expect(res.status, `Falha na requisição API: ${res.status} ${JSON.stringify(res.json)}`).toBe(expectedStatus);
}
