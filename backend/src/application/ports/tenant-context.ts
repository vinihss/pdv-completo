/**
 * Identidade de tenant e de ator — FASE 0 da refatoração (ports/adapters).
 *
 * Contrato CONGELADO: use cases e Unit-of-Worker falam em `TenantContext`,
 * nunca em `search_path`/pool. O adapter decide como rotear (hoje: pool por
 * schema; amanhã: RLS por `app.tenant_id`).
 */
export interface TenantContext {
  tenantId: string;
  slug: string;
  /** ADIÇÃO (escopo/schema-por-tenant vigente): schema do tenant no Postgres, usado pelo adapter para rotear o pool. `tenantId` === `slug` no registry atual. */
  schemaName: string;
  source: "http" | "worker" | "webhook" | "internal";
}

export interface PlatformContext {
  actor: "system" | "operator";
  reason: string;
}
