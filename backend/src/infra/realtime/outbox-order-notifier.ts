import type { OrderNotifier } from "../../application/ports/effects.js";
import type { Id, Json } from "../../application/ports/repositories.js";
import type { TenantContext } from "../../application/ports/tenant-context.js";
import { db, type Db } from "../db/client.js";
import { tenantDb } from "../db/tenant-db.js";
import { enqueueEvent } from "./outbox-dispatcher.js";

/**
 * Adapter do port `OrderNotifier` (ports/effects.ts) — FASE 0.
 *
 * O port espelha o uso de `enqueueEvent(tx, room, eventType, payload)`: a
 * intenção de emitir um evento realtime é gravada em `outbox_event` e o
 * dispatcher (poll de 200 ms) publica — quem faz o broadcast é o gateway Go
 * (ver comentário em `outbox-dispatcher.ts`). Ou seja: "notificar" aqui é
 * ENFILEIRAR, não enviar; entrega/at-least-once é do outbox.
 *
 * DIFERENÇA EM RELAÇÃO AO `enqueueEvent` DOS USE CASES: o port não é
 * transacional (está em effects, fora da janela do Unit-of-Worker), então este
 * adapter abre a sua própria transação de apenas UM insert. A escrita do
 * evento sai do rollback da escrita de domínio — aceitável e intencional num
 * notify pós-commit; dentro de transação de domínio use `session.outbox`
 * (`OutboxWriter`), que compartilha a transação.
 *
 * ROTEAMENTO DE TENANT: sem ALS. `createOrderNotifier(tenant)` liga o adapter
 * ao pool dedicado do `tenant.schemaName` (`tenantDb`); sem tenant explícito,
 * o default é o proxy `db` (escopo ALS corrente — o mesmo de hoje).
 *
 * NOTA SOBRE O WHATSAPP: `integrations/whatsapp/whatsapp.notifier.ts` NÃO é
 * a implementação deste port — ele recebe `orderId` e consulta pedido/cliente
 * para achar o telefone. O port recebe payload JÁ PREPARADO e em formato de
 * evento realtime (room/type), então a tradução correta é este outbox. Um
 * "notificar por WhatsApp" com payload pronto exigiria outro port (ex.:
 * `CustomerNotifier`), ficou fora do escopo desta onda.
 */
export class OutboxOrderNotifier implements OrderNotifier {
  /** `db` por default = proxy ALS (comportamento dos `enqueueEvent` atuais). */
  constructor(private readonly database: Db = db) {}

  async notify(input: { room: string; type: string; aggregateId?: Id; payload?: Json }): Promise<void> {
    // Mesma convenção do `PostgresOutboxWriter`: sem payload, o `aggregateId`
    // vira o corpo (não se perde); com payload, ele é gravado como veio (todos
    // os `enqueueEvent` atuais já põem o id dentro do payload).
    const payload = input.payload ?? { aggregateId: input.aggregateId ?? null };
    await this.database.transaction(async (tx) => {
      await enqueueEvent(tx, input.room, input.type, payload);
    });
  }
}

/**
 * Factory pronta para o composition root: tenant explícito → pool dedicado daquele
 * schema (sem ALS); sem tenant → proxy `db` (ALS corrente, como hoje).
 */
export function createOrderNotifier(tenant?: TenantContext): OrderNotifier {
  return new OutboxOrderNotifier(tenant ? tenantDb(tenant.schemaName) : db);
}
