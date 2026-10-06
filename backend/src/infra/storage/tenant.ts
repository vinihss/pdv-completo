/**
 * SEAM — o schema (tenant) do storage. Única função do backend que decide de
 * qual loja é a operação de arquivo.
 *
 * Fase 2 (`docs/15-multi-tenant-schema.md` §4.7): agora lê o
 * `AsyncLocalStorage` — populado no `onRequest` a partir do subdomínio —
 * para decidir o diretório do tenant. O comportamento de fallback (sem
 * request no ar) continua sendo `DEFAULT_TENANT_SCHEMA ?? "public"`,
 * exatamente como antes.
 */
import { resolveTenantSchemaInScope } from "../db/tenant-context.js";

export const FALLBACK_TENANT_SCHEMA = "public";

export function resolveTenantSchema(): string {
  return resolveTenantSchemaInScope();
}
