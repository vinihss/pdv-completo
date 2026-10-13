/**
 * Port da central de alertas (`alert`) — o sino.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/alert.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id } from "../../ports/repositories/shared.js";

/** Linha de `alert` (sino). */
export interface AlertRecord {
  id: Id;
  kind: string;
  title: string;
  body: string | null;
  orderId: Id | null;
  channel: string | null;
  /** Tokens de audiência: papel (`manager`) e/ou `user:<id>`. NULL/vazio = público. */
  audienceRoles: string[] | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * ADIÇÃO (Onda 2): persistência da central de alertas. O recorte de
 * visibilidade (audiência por papel/`user:<id>`) é SQL e mora NO ADAPTER — o
 * port só recebe `role`/`userId`, e REST/WS continuam usando a mesma régua de
 * sempre (`visibleTo` original).
 */
export interface AlertRepository {
  /** Insere a linha do alerta com os tokens de audiência (papéis + `user:<id>`). */
  create(input: {
    kind: string;
    title: string;
    body?: string | null;
    orderId?: Id | null;
    channel?: string | null;
    audienceRoles: string[];
  }): Promise<AlertRecord>;
  /** Alertas visíveis ao papel/usuário, mais recentes primeiro. */
  listVisible(query: { role: string; userId?: Id | null; limit: number; unreadOnly?: boolean }): Promise<AlertRecord[]>;
  /** Contadores do sino — do conjunto TODO visível, sem o `unreadOnly` (badge marcaria zero). */
  countVisible(query: { role: string; userId?: Id | null }): Promise<{ total: number; unread: number }>;
  /** Marca como lido só o que o chamador enxerga; devolve quantas linhas mudaram. */
  markRead(query: { role: string; userId?: Id | null; orderId?: Id }): Promise<number>;
}
