import type { EntityId } from "./persistence.js";
import type { TenantContext } from "./tenant-context.js";

export interface IdempotencyRequest {
  tenant: TenantContext;
  key: string;
  requestHash: string;
  operation: string;
}

export type IdempotencyResult<T> =
  | { status: "acquired"; correlationId: EntityId }
  | { status: "completed"; response: T; httpStatus: number }
  | { status: "processing" }
  | { status: "conflict" };

export interface IdempotencyPort {
  acquire<T>(request: IdempotencyRequest): Promise<IdempotencyResult<T>>;
  complete<T>(input: { tenant: TenantContext; correlationId: EntityId; response: T; httpStatus: number }): Promise<void>;
  fail(input: { tenant: TenantContext; correlationId: EntityId }): Promise<void>;
}
