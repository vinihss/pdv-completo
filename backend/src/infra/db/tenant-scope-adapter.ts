import type { TenantScopeStore } from "../../application/ports/effects.js";
import { currentTenantScope, enterTenantScope } from "./tenant-context.js";

/**
 * Adapter do port `TenantScopeStore` (application/ports/effects.ts).
 *
 * Encapsula o ALS de `infra/db/tenant-context` para o `login.usecase`: a
 * application não importa `infra/db`, e o adapter é o único que conhece as
 * funções `currentTenantScope`/`enterTenantScope`. O trabalho de resolver o
 * tenant pelo host quando o ALS está vazio continua no use case (via dep
 * `resolveTenant`); aqui só entram/consultam o escopo.
 */
export class TenantScopeAdapter implements TenantScopeStore {
  current(): { tenantId: string; slug: string; isDefault: boolean } | undefined {
    const scope = currentTenantScope();
    return scope
      ? {
          tenantId: scope.tenantId,
          slug: scope.slug,
          isDefault: scope.isDefault,
        }
      : undefined;
  }

  enter(scope: { tenantId: string; slug: string; isDefault: boolean }): void {
    enterTenantScope(scope);
  }
}
