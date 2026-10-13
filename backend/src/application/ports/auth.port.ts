import type { EntityId } from "./persistence.js";
import type { TenantContext } from "./tenant-context.js";

export interface AuthenticatedUser {
  id: EntityId;
  tenantId: string;
  role: string;
  active: boolean;
}

export interface UserStatusReader {
  findActiveUser(tenant: TenantContext, userId: EntityId): Promise<AuthenticatedUser | null>;
}

export interface PinVerifier {
  verify(pin: string, encodedHash: string): Promise<boolean>;
}

export interface AccessTokenIssuer {
  issue(user: AuthenticatedUser): Promise<string>;
}
