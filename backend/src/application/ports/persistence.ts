/** Identificadores e tipos neutros de persistência; não exportar tipos Drizzle/pg daqui. */
export type EntityId = string;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PageRequest {
  limit: number;
  /** Cursor opaco, definido pelo adapter. */
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Erros independentes do driver, mapeados pelos adapters de persistência. */
export type PersistenceErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONSTRAINT"
  | "UNAVAILABLE"
  | "UNKNOWN";

export class PersistenceError extends Error {
  constructor(
    public readonly code: PersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PersistenceError";
  }
}
