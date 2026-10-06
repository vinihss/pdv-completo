// Regras de TENANT que são PUROAS — sem I/O, sem banco, sem env.
//
// Tudo que decide "este `Host` é a loja X, ou é a loja default, ou não é
// loja nenhuma" mora aqui, e por isso é testável sem subir request nem banco.
// A parte que fala com o registry (`public.tenant`) é de infra; a que junta as
// duas é o use case (`application/tenant/resolve-tenant.usecase.ts`).
//
// Fonte das regras: `docs/15-multi-tenant-schema.md` §3.1 (fluxo), §4.8 (a chave
// é o slug no Host) e §3.2 (o `CHECK` do `schema_name` no registry).

/**
 * O `CHECK` do `slug` em `public.tenant` (`^ [a-z0-9][a-z0-9-]* $`), repetido
 * aqui. O banco é a barreira; isto é a barreira do lado do request, e as duas
 * precisam casar: um `slug` aceito aqui e recusado lá (ou o contrário) vira um
 * 404 que ninguém entende.
 */
export const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * O `CHECK` do `schema_name` (`^ tenant_[a-z0-9_]+ $`). É a barreira que impede
 * injeção de SQL quando o nome do schema entrar num `search_path` ou num
 * identificador qualificado (Fase 2/3). O `CHECK` no banco é a primeira linha de
 * defesa — esta é a segunda, para o caso de o constraint cair.
 */
export const TENANT_SCHEMA_PATTERN = /^tenant_[a-z0-9_]+$/;

/**
 * Formato de identificador de schema Postgres, para o schema que vem do
 * AMBIENTE (`DEFAULT_TENANT_SCHEMA`), e não do registry. É mais frouxo que o
 * padrão do registry de propósito: o schema default é `public` até o cutover
 * (§6.2 da Fase 7), e `public` não casa `^tenant_…`. Ainda assim só aceita
 * `[a-z_][a-z0-9_]*` — sem ponto, sem aspas, sem nada que quebre um
 * `SET search_path`.
 */
export const SAFE_SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Subdomínios da plataforma. Não são loja: `app.` é a aplicação interna,
 * `api.` é a API (que atende todos os tenants) e `www.` é o redirecionamento do
 * domínio próprio. Se um deles resolvesse para um tenant, qualquer um poderia
 * registrar `app` no registry e tomar a origem do app interno.
 *
 * Eles caem no tenant DEFAULT — não em 404 — porque é o que mantém o
 * comportamento de hoje (§3.1): o `app.seudominio.com.br` de uma instalação de
 * uma loja só precisa continuar falando com aquela loja.
 */
export const RESERVED_SUBDOMAINS: readonly string[] = ["www", "app", "api"];

/** `true` quando o valor casa o `CHECK` do `slug` no registry. */
export function isValidTenantSlug(value: string): boolean {
  return TENANT_SLUG_PATTERN.test(value);
}

/** `true` quando o `schema_name` vindo do registry é um identificador seguro. */
export function isValidTenantSchemaName(value: string): boolean {
  return TENANT_SCHEMA_PATTERN.test(value);
}

/** `true` para o schema default vindo do ambiente (`public`, `tenant_x`, …). */
export function isSafeSchemaName(value: string): boolean {
  return SAFE_SCHEMA_NAME_PATTERN.test(value);
}

/**
 * Normaliza um `Host` para a forma de comparação: minúsculas, sem porta, sem
 * ponto final e sem espaço em volta.
 *
 * `null` = não parece um host (vazio, longo demais, ou com caractere que não
 * aparece em hostname — barra, espaço, `..`). O chamador trata `null` como
 * "host inválido" e devolve 404: nunca o default (regra de ouro do §4.8).
 */
export function normalizeTenantHost(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[")) {
    // Literal IPv6 (`[::1]:5173`): recorta o que está entre os colchetes. O
    // resultado não é um hostname válido, então cai no 404 como qualquer outro
    // host malformado.
    const end = host.indexOf("]");
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else if (host.includes(":")) {
    // `host:port`. O host não tem dois-pontos, então o primeiro é a fronteira.
    host = host.slice(0, host.indexOf(":"));
  }
  host = host.replace(/\.+$/, "");
  if (host.length === 0 || host.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  // Rótulo vazio (`a..b`, `.a.com`) ou ponto no fim já tratado acima.
  if (host.split(".").some((label) => label.length === 0)) return null;
  return host;
}

export type TenantHostMatch =
  /** `localhost`/intranet (1 rótulo) ou apex da plataforma: tenant default. */
  | { kind: "default"; reason: "local" | "apex" }
  /** Rótulo reservado da plataforma (`www`/`app`/`api`): é o tenant default. */
  | { kind: "reserved" }
  /** Subdomínio de tenant: `pdv1.seudominio.com.br` → `pdv1`. */
  | { kind: "slug"; slug: string }
  /** Host que não é da plataforma e não casa nenhum `custom_domain`: 404. */
  | { kind: "invalid" }
  /** Subdomínio da plataforma cujo rótulo não casa o `CHECK` do `slug`: 404. */
  | { kind: "invalid-subdomain" };

/**
 * Classifica um host JÁ normalizado.
 *
 * `rootDomain` (ex.: `seudominio.com.br`) é o domínio da plataforma — o mesmo
 * `${ROOT_DOMAIN}` que o Caddy usa. É ele que separa o APEX de um subdomínio de
 * tenant, e a distinção não dá para fazer só contando rótulos: o §3.1 assumia um
 * TLD de uma label (`.tech`), e num domínio `.com.br` o apex
 * `seudominio.com.br` TEM 3 rótulos — sem o `rootDomain` ele seria lido como
 * subdomínio de slug `seudominio`, que não existe, e o apex daria 404 num
 * endereço que tem que servir a loja default. Com o `rootDomain` unset, vale a
 * heurística do §3.1 (é o comportamento de antes desta assinatura, e o
 * `resolveTenant` loga para o operador perceber que faltou a env).
 *
 * Ordem: rótulo reservado → apex → subdomínio. O rótulo reservado é checado
 * PRIMEIRO de propósito: `app.`/`api.`/`www.` são da plataforma e não podem ser
 * tomados nem por uma linha de registry com `custom_domain` correspondente — se
 * a checagem viesse depois, quem registrasse `app.seudominio.com.br` no registry
 * serviria a própria vitrine em cima da origem do app interno.
 */
export function matchTenantHost(host: string, rootDomain?: string | null): TenantHostMatch {
  const labels = host.split(".");

  // `localhost` e nome de intranet: uma label só, e não é subdomínio de nada.
  if (labels.length === 1 || host.endsWith(".localhost")) return { kind: "default", reason: "local" };

  if (labels.length > 2 && RESERVED_SUBDOMAINS.includes(labels[0])) return { kind: "reserved" };

  const root = typeof rootDomain === "string" ? rootDomain.trim().toLowerCase().replace(/\.+$/, "") : "";
  if (root !== "") {
    if (host === root) return { kind: "default", reason: "apex" };
    if (!host.endsWith(`.${root}`)) {
      // Não é a plataforma nem o apex: só um `custom_domain` do registry pode
      // salvar esse host (ex.: `umamisushiarte.com.br`), e quem chama decide.
      return { kind: "invalid" };
    }
    const first = labels[0];
    return isValidTenantSlug(first) ? { kind: "slug", slug: first } : { kind: "invalid-subdomain" };
  }

  // Sem `rootDomain`: a heurística do §3.1 (TLD de uma label).
  if (labels.length < 3) return { kind: "default", reason: "apex" };
  const first = labels[0];
  if (!isValidTenantSlug(first)) return { kind: "invalid" };
  return { kind: "slug", slug: first };
}
