// O tenant IMPLÍCITO — o alvo das operações de banco em ambiente single-tenant.
//
// POR QUE ISTO EXISTE
// -------------------
// Em ambiente single-tenant (o dev padrão: `TENANT_ROUTING=false` e
// `DEFAULT_TENANT_SCHEMA` vazio) o app inteiro roda no schema `public`:
// `resolveTenantSchemaInScope()` cai em `public` quando não há escopo ALS e
// não há `DEFAULT_TENANT_SCHEMA` no ambiente. Nesse modo o registry
// (`public.tenant`) fica VAZIO — ninguém insere linha nele, porque só o
// provisionamento de tenant (`provision-tenant.ts`) insere.
//
// A CLI e a TUI listam os tenants do registry. Sem esta peça, os fluxos que
// operam sobre um tenant (reset de PIN, adicionar usuário, editar
// configurações, dump) ficavam SEM ALVO no dev, mesmo existindo um
// `store_settings` de verdade — que vive em `public`, não em `tenant_<slug>`.
//
// O slug reservado `default` representa esse tenant. Ele NUNCA aparece no
// registry: se um tenant real for provisionado com o slug `default`, a linha
// do registry vence (a busca no registry vem ANTES do fallback).
//
// SEGURANÇA
// ---------
// O schema default vem do ambiente (`DEFAULT_TENANT_SCHEMA`) e só é aceito
// se casar `^[a-z_][a-z0-9_]*$` — o mesmo padrão de `isSafeSchemaName`, que
// é o que o pool dedicado exige (`search_path=<schema>,public,pg_temp`). Um
// valor fora do padrão é ignorado e o default vira `public`.
import { DEFAULT_TENANT_ID, isSafeSchemaName } from "../../domain/tenant.js";
import type { TenantScope } from "./tenant-context.js";

/** Slug reservado do tenant implícito (o "default" do single-tenant). */
export const DEFAULT_TENANT_SLUG = "default";

/**
 * Schema default: `DEFAULT_TENANT_SCHEMA` do ambiente quando válido,
 * senão `public`.
 */
export function defaultTenantSchema(): string {
  const fromEnv = process.env.DEFAULT_TENANT_SCHEMA?.trim();
  if (fromEnv && isSafeSchemaName(fromEnv)) return fromEnv;
  return "public";
}

/**
 * Escopo do tenant implícito — `undefined` quando o slug não é o reservado.
 *
 * `isDefault: true` marca o escopo como "loja padrão" (o mesmo sinal que o
 * `resolveTenant` usa para o tenant apex), para o código que diferencia
 * loja padrão de loja cadastrada.
 */
export function defaultTenantScope(slug: string): TenantScope | undefined {
  if (slug !== DEFAULT_TENANT_SLUG) return undefined;
  return {
    tenantId: DEFAULT_TENANT_ID,
    slug: DEFAULT_TENANT_SLUG,
    isDefault: true,
  };
}
