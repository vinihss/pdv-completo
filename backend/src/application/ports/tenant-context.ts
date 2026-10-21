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
  /**
   * O schema do tenant NÃO faz mais parte do contexto: no modelo por LINHA
   * (`docs/28`) todas as lojas moram no mesmo schema (`public`) e quem separa
   * uma da outra é a coluna `tenant_id` + a policy de RLS (a Fase 2). O
   * adapter roteia pelo `tenantId` — o pool é por tenant, não por schema.
   */
  source: "http" | "worker" | "webhook" | "internal";
}

export interface PlatformContext {
  actor: "system" | "operator";
  reason: string;
}
