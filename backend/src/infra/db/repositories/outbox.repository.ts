import type { Tx } from "../client.js";
import { outboxEvents } from "../schema.js";
import type { Id, OutboxWriter } from "../../../application/ports/repositories.js";

/** Colunas `text` que guardam JSON: aceitam objeto (serializado aqui) ou a string já pronta. */
function toJsonText(value: unknown, fallback = "{}"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

// =====================================================================
// Outbox (espelha `enqueueEvent`)
// =====================================================================

export class PostgresOutboxWriter implements OutboxWriter {
  constructor(private readonly tx: Tx) {}

  /**
   * `room` obrigatório (coluna real) e `type` → `eventType`, exatamente como
   * `enqueueEvent(tx, room, eventType, payload)`.
   *
   * `aggregateId` NÃO tem coluna própria em `outbox_event`: quando o caller
   * passa `payload`, ele é gravado como veio (id dentro do payload, como todos
   * os `enqueueEvent` atuais fazem); quando não passa, vira
   * `{"aggregateId": "..."}` para não se perder. Se um dia o id precisar ser
   * consultável fora do payload, é uma coluna nova em migration própria.
   */
  async enqueue(input: { room: string; type: string; aggregateId: Id; payload?: unknown }): Promise<void> {
    await this.tx.insert(outboxEvents).values({
      room: input.room,
      eventType: input.type,
      payload: input.payload === undefined ? JSON.stringify({ aggregateId: input.aggregateId }) : toJsonText(input.payload, "{}"),
    });
  }
}

