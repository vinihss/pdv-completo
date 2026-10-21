import { sql } from "drizzle-orm";
import { tenantDb } from "./tenant-db.js";
import type { Tx } from "./client.js";
import type {
  TenantUnitOfWork,
  TenantSession,
} from "../../application/ports/unit-of-work.js";
import type { TenantContext } from "../../application/ports/tenant-context.js";

export type TenantSessionFactory = (tx: Tx) => TenantSession;

/**
 * Unit-of-Worker/Request Postgres: abre UMA transação no pool do schema do
 * tenant e entrega um `TenantSession` (repositórios + audit + outbox) ao work.
 *
 * Roteamento: `tenantDb(tenant.schemaName)` — pool DEDICADO do schema, cujo
 * `options: '-c search_path=...'` está fixado no startup packet. Este é o
 * isolamento REAL hoje: dois tenants nunca enxergam os dados um do outro
 * porque falam com pools diferentes (schema-por-tenant, `docs/15`).
 *
 * `set_config('app.tenant_id', ..., true)`: grava o id do tenant no escopo da
 * SESSÃO da transação (`is_local = true`, descarta no fim). Hoje nada lê essa
 * GUC — é preparação para o RLS pendente (docs/23): quando existir
 * `app.tenant_id = current_setting(...)` nas policies, o mesmo Unit-of-Worker
 * já entrega o contexto certo sem mudança de código. É forward-compatível
 * porque é aditivo: não altera nenhum comportamento enquanto RLS não existir.
 */
export class PostgresTenantUnitOfWork implements TenantUnitOfWork {
  constructor(private readonly createSession: TenantSessionFactory) {}

  async run<T>(tenant: TenantContext, work: (session: TenantSession) => Promise<T>): Promise<T> {
    if (!tenant.tenantId) throw new Error("tenant_context_required");
    // O id do tenant é a chave do pool: o `app.tenant_id` vai no startup packet
    // (é o que faz o trigger de `tenant_id` preencher a coluna em qualquer
    // inserção, e o que a policy de RLS compara).
    const db = tenantDb(tenant.tenantId); // pool dedicado do tenant — a barreira é o RLS
    return db.transaction(async (tx: Tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenant.tenantId}, true)`);
      return work(this.createSession(tx));
    });
  }
}
