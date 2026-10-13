/**
 * Port do outbox — eventos de realtime na MESMA transação da escrita de
 * domínio (audit + outbox juntos, AGENTS.md).
 *
 * NOTA SOBRE O `OutboxWriter` (adaptação ao modelo real): a spec original
 * previa `OutboxWriter.enqueue({ type, aggregateId, payload })`, mas o código
 * real do repositório usa `enqueueEvent(tx, room, eventType, payload)`. Para
 * não perder informação na tradução, o port traz `room: string` OBRIGATÓRIO
 * (coluna real `outbox_event.room` — sem ela o evento não sabe para onde ir) e
 * o "type" do spec vira `type` aqui / `eventType` no banco. O adapter traduz
 * 1:1.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/outbox.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id, Json } from "./shared.js";

export interface OutboxWriter {
  enqueue(input: {
    /** ADIÇÃO ao spec: coluna real `outbox_event.room` — sem ela o evento não sabe para onde ir (ver nota no topo). */
    room: string;
    /** O "type" do spec vira `eventType` no banco. */
    type: string;
    aggregateId: Id;
    payload?: Json;
  }): Promise<void>;
}
