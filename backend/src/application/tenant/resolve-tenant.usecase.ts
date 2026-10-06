// Resolução de tenant: `Host` → loja. Fase 1 do
// `docs/15-multi-tenant-schema.md` §6.
//
// As REGRAS (o que é apex, o que é rótulo reservado, o que é slug inválido) são
// puras e estão em `domain/tenant.ts`; o ACESSO ao registry é infra
// (`infra/tenant/registry.ts`); aqui é só a cola que decide o resultado — que é
// use case porque a decisão (404 vs default vs 503) é regra de negócio.
//
// O `resolveTenant` é a função que a Fase 2 vai chamar no `onRequest` do Fastify
// (§3.1) para popular o ALS; por isso ela já devolve o `schemaName` e já lança
// os mesmos `AppError` que o middleware precisa (404 `tenant_not_resolved`,
// 403 `tenant_inactive`).

import { Errors } from "../../domain/errors.js";
import {
  isSafeSchemaName,
  isValidTenantSchemaName,
  matchTenantHost,
  normalizeTenantHost,
} from "../../domain/tenant.js";
import { findTenantByCustomDomain, findTenantBySlug } from "../../infra/tenant/registry.js";
import { resolveTenantSchema } from "../../infra/storage/index.js";
import { getStoreSettingsUsecase } from "../store-settings.usecases.js";

/**
 * Slug do tenant default (apex, `localhost`, rótulo reservado ou kill-switch
 * ligado). O §6.2 do doc 15 já usa `slug='default'` para a linha do default no
 * registry no cutover; até lá o default não é uma linha do registry — é o
 * ambiente (`DEFAULT_TENANT_SCHEMA`) — e este é o rótulo que o cliente vê.
 */
export const DEFAULT_TENANT_SLUG = "default";

/**
 * KILL-SWITCH do roteamento por `Host`, no mesmo vocabulário default-deny do
 * gate `WS_DISPATCH` do gateway Go.
 *
 * ⚠️ O DEFAULT É DESLIGADO, e isso é deliberado (Fase 1): o registry começa
 * vazio, e com o roteamento ligado qualquer subdomínio/domínio próprio que não
 * estivesse cadastrado levaria 404 — o que derrubaria justamente as lojas que
 * já estão no ar (`umamisushiarte.com.br` responde hoje porque o processo todo
 * fala o schema default). Desligado, o comportamento é **idêntico ao de hoje**
 * (§6, Fase 1: "`DEFAULT_TENANT_SCHEMA=public` → comportamento idêntico ao de
 * hoje"), e ligar é uma env só depois de o registry estar populado — o que só
 * faz sentido com a Fase 2/3 no ar.
 *
 * Ler `process.env` a cada chamada (e não no load) é o que torna o kill-switch
 * testável sem reimportar o módulo; é a mesma razão da seam em
 * `infra/storage/tenant.ts`.
 */
export function tenantRoutingEnabled(): boolean {
  const raw = (process.env.TENANT_ROUTING ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export type ResolvedTenant = {
  slug: string;
  /** Schema de onde o processo fala. Nunca vai para o cliente. */
  schemaName: string;
  /** `true` quando veio do ambiente (apex/`localhost`/reservado/kill-switch). */
  isDefault: boolean;
};

/** Valida e devolve o schema default do ambiente. */
function defaultSchemaName(): string {
  const value = resolveTenantSchema();
  if (!isSafeSchemaName(value)) {
    // `DEFAULT_TENANT_SCHEMA` é controlado pela operação, mas entra num
    // `search_path` na Fase 2: valida na entrada, nunca confie no env para
    // montar identificador.
    console.error(`[tenant] DEFAULT_TENANT_SCHEMA inválido: ${JSON.stringify(value)} — usando o fallback`);
    return "public";
  }
  return value;
}

/**
 * Domínio da plataforma (o mesmo `${ROOT_DOMAIN}` do `deploy/Caddyfile`). É o
 * que separa o apex (`seudominio.com.br`) de um subdomínio de tenant
 * (`pdv1.seudominio.com.br`), e a distinção não dá para fazer contando rótulos
 * num TLD de duas labels (§3.1 do doc 15 assumiu `.tech`).
 *
 * Sem essa env a resolução ainda funciona (cai na heurística do §3.1), mas num
 * domínio `.com.br` o apex passa a ser lido como subdomínio de slug
 * `seudominio` e a levar 404 — por isso o warn, para o operador ver que faltou.
 */
function platformRootDomain(): string | null {
  const raw = (process.env.PLATFORM_ROOT_DOMAIN ?? "").trim();
  if (raw === "") return null;
  const normalized = normalizeTenantHost(raw);
  if (!normalized) {
    console.error(
      `[tenant] PLATFORM_ROOT_DOMAIN inválido (${JSON.stringify(raw)}) — usando a heurística de rótulos`,
    );
    return null;
  }
  return normalized;
}

function defaultTenant(): ResolvedTenant {
  return { slug: DEFAULT_TENANT_SLUG, schemaName: defaultSchemaName(), isDefault: true };
}

function fromRecord(record: { slug: string; schemaName: string; status: string }): ResolvedTenant {
  if (record.status !== "active") throw Errors.tenantInactive(record.slug);
  if (!isValidTenantSchemaName(record.schemaName)) {
    // Não deveria existir: o `CHECK` do registry barra isso (§3.2). Se existir,
    // é o registry corrompido — e o nome do schema entra num `search_path` na
    // Fase 2, então a segunda barreira (código) é obrigatória mesmo com o
    // constraint no banco.
    console.error(
      `[tenant] schema_name fora do padrão no registry (slug=${record.slug}): ${JSON.stringify(record.schemaName)}`,
    );
    throw Errors.tenantSchemaUnavailable(record.slug, record.schemaName);
  }
  return { slug: record.slug, schemaName: record.schemaName, isDefault: false };
}

/**
 * Resolve o tenant de um `Host` (ou de um host vindo da query, que é como a SPA
 * chama: na API o `Host` é `api.seudominio.com.br`, que não identifica loja
 * nenhuma — o Caddy injeta `X-Tenant-Host` com o MESMO host da API).
 *
 * Ordem das regras (§3.1/§4.8):
 *  1. kill-switch desligado → default, sem olhar o `Host`;
 *  2. `Host` que não parece hostname → 404 (nunca default);
 *  3. rótulo reservado (`www`/`app`/`api`) → default, SEM consultar o registry:
 *     são hosts da plataforma e uma linha de registry não pode tomá-los;
 *  4. domínio próprio (`custom_domain`) — antes da regra do subdomínio, porque
 *     `umamisushiarte.com.br` tem 3 rótulos e a 1ª label (`umamisushiarte`)
 *     não é o slug da loja (`umami`), e porque o domínio próprio de uma loja
 *     também pode estar sob o domínio da plataforma;
 *  5. `localhost` ou apex → default;
 *  6. subdomínio → slug no registry; não existe (ou o slug é inválido) → 404.
 */
export async function resolveTenant(rawHost: string | undefined | null): Promise<ResolvedTenant> {
  if (!tenantRoutingEnabled()) return defaultTenant();

  const host = normalizeTenantHost(rawHost);
  if (!host) throw Errors.tenantNotResolved();

  const rootDomain = platformRootDomain();
  const match = matchTenantHost(host, rootDomain);
  if (match.kind === "reserved") return defaultTenant();

  const byDomain = await findTenantByCustomDomain(host);
  if (byDomain) return fromRecord(byDomain);

  if (match.kind === "default") return defaultTenant();
  if (match.kind !== "slug") throw Errors.tenantNotResolved();

  const bySlug = await findTenantBySlug(match.slug);
  if (!bySlug) throw Errors.tenantNotResolved();
  return fromRecord(bySlug);
}

/**
 * O que o cliente final (a vitrine de pedidos) recebe: identidade + marca da
 * loja. `schema_name` NÃO sai daqui — é topologia interna do banco, e
 * devolvê-la transformaria o endpoint numa dica de qual schema existe.
 *
 * `storeId` não tem tabela própria desde PR #54 (o `stores` foi removido e
 * `store_settings` é singleton por schema, §8 do doc 15): o identificador
 * público da loja, para o cliente, é o `slug`. O campo continua no contrato
 * porque o app público (`apps/pedido-public`) já o consome.
 */
export type PublicTenant = {
  storeId: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  usesDelivery: boolean;
  kitchenEnabled: boolean;
};

/**
 * Payload público do tenant. Os dados de loja (nome/logo/cor/flags) vêm de
 * `store_settings` do schema resolvido.
 *
 * ⚠️ LIMITADO À FASE 1: só o schema que o PROCESSO fala tem dados legíveis —
 * `db` ainda é um pool único sem `search_path` por request (Fase 2).
 * Ler o `store_settings` de outro schema por SQL qualificado aqui pareceria a
 * solução e não é: o cardápio, o carrinho e o pedido continuam saindo do schema
 * default, então a vitrine mostraria a marca da loja B com o catálogo da loja A
 * (e o `logoUrl` da loja B seria servido do diretório da A — que é o bug do
 * §5.2 de novo). Por isso um tenant cujo schema não é o do processo responde
 * 503 `tenant_schema_unavailable`, e a linha que muda isso é a mesma que muda
 * quando o ALS entrar: ler `store_settings` pelo `db` escopado.
 */
export async function getPublicTenantUsecase(rawHost: string | undefined | null): Promise<PublicTenant> {
  const tenant = await resolveTenant(rawHost);

  if (tenant.schemaName !== resolveTenantSchema()) {
    console.error(
      `[tenant] ${tenant.slug} resolve para o schema ${tenant.schemaName}, que este processo não fala ` +
        `(processo fala ${resolveTenantSchema()}) — vitrine indisponível até a Fase 2/3`,
    );
    throw Errors.tenantSchemaUnavailable(tenant.slug, tenant.schemaName);
  }

  const settings = await getStoreSettingsUsecase();
  return {
    storeId: tenant.slug,
    slug: tenant.slug,
    name: settings.merchantName,
    logoUrl: settings.logoUrl,
    primaryColor: settings.brandColor,
    usesDelivery: settings.usesDelivery,
    kitchenEnabled: settings.kitchenEnabled,
  };
}
