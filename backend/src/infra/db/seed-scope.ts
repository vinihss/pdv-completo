// O escopo de tenant dos SEEDS.
//
// POR QUE O SEED PRECISA DE ESCOPO
// --------------------------------
// A coluna `tenant_id` (migration `0013_tenant_id.sql`) é preenchida por um
// TRIGGER que lê o `app.tenant_id` — e o GUC mora no **startup packet do
// pool** (o pool é por tenant). Um seed que escreve sem escopo usaria um pool
// sem o GUC → a coluna ficaria nula → o `NOT NULL` (migration `0014`) a
// rejeitaria.
//
// O seed do default (base e demo) roda no tenant default; o bootstrap do
// provisionamento (`runProdSeed` dentro de `runInTenantScope`) roda no tenant
// que está sendo criado. Nos dois casos o escopo é o mesmo que o do app —
// e é ele que diz ao pool qual `app.tenant_id` carregar.
import { currentTenantScope, type TenantScope } from "./tenant-context.js";
import { defaultTenantScope } from "./default-tenant.js";
import { DEFAULT_TENANT_SLUG } from "../../application/tenant/resolve-tenant.usecase.js";

/**
 * O escopo do seed: o tenant corrente (quando o seed roda dentro de um
 * escopo — o bootstrap do provisionamento) ou o tenant default.
 */
export function seedScope(): TenantScope {
  const atual = currentTenantScope();
  if (atual) return atual;
  const padrao = defaultTenantScope(DEFAULT_TENANT_SLUG);
  if (!padrao) {
    throw new Error("[seed] não consegui montar o escopo do tenant default");
  }
  return padrao;
}
