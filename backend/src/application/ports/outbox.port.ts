import type { EntityId, JsonValue } from "./persistence.js";

export interface OutboxMessage {
  type: string;
  aggregateId: EntityId;
  payload?: JsonValue;
  /** Chave opcional para deduplicação do consumidor. */
  deduplicationKey?: string;
}

/** Enfileira intenção durável dentro da mesma transação da mudança de negócio. */
export interface OutboxWriter {
  enqueue(message: OutboxMessage): Promise<void>;
}

/** Dispatcher/worker é adapter de runtime, não parte da aplicação. */
export interface OutboxDispatcher {
  start(): { stop(): Promise<void> | void };
}
