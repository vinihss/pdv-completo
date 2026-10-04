/**
 * SEAM — o schema (tenant) do storage. Única função do backend que decide de
 * qual loja é a operação de arquivo.
 *
 * Hoje ela não pode fazer mais que isto: o multi-tenant é **plano**
 * (`docs/15-multi-tenant-schema.md`, status "plano"), então o schema é o
 * default. Quando a Fase 2 (§6 do mesmo doc) entrar, a leitura do
 * `AsyncLocalStorage` — populado no `onRequest` a partir do subdomínio —
 * substitui **o corpo desta função** e nada mais: os use cases e a rota de
 * serving chamam `getStorage()`, que já delega para cá.
 *
 * Ler `process.env` a cada chamada (em vez de um snapshot no load) é de
 * propósito: é o que faz a seam testável sem subir request nenhum, e é
 * exatamente o formato que a leitura do ALS vai ter.
 */
export const FALLBACK_TENANT_SCHEMA = "public";

export function resolveTenantSchema(): string {
  return process.env.DEFAULT_TENANT_SCHEMA ?? FALLBACK_TENANT_SCHEMA;
}
