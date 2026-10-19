/**
 * Origem pública do app, montada a partir do REQUEST (não do `config`).
 *
 * Por que na rota: os links que saem em email (convite e recuperação de senha)
 * precisam ser ABSOLUTOS e apontar para o host por onde a pessoa acessa o
 * sistema — em multi-tenant cada loja tem o seu subdomínio. Quem conhece o host
 * é o request; a `application` não lê `req` nem `process.env` (regra de camadas
 * do `docs/agent-backend.md`), então a origem é montada aqui e INJETADA no use
 * case como dado (mesmo desenho do `downloadLinks` do `provisioning.routes`).
 *
 * Ordem de resolução:
 *   1. `x-forwarded-host`/`x-forwarded-proto` (o Caddy reescreve os dois);
 *   2. `host` do request + `req.protocol` (o Fastify roda com `trustProxy`).
 * Fallback final: `PLATFORM_ROOT_DOMAIN` (lido do ambiente AQUI, não no use
 * case), que existe para o caso de o request não trazer host nenhum — sem host
 * montamos o link relativo e o email sai sem domínio, mas o fluxo não quebra.
 */
import type { FastifyRequest } from "fastify";

function firstHeaderValue(value: unknown): string | null {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  if (typeof value !== "string") return null;
  const first = value.split(",")[0]?.trim() ?? "";
  return first.length > 0 ? first : null;
}

export function requestOrigin(req: FastifyRequest): string {
  const proto = firstHeaderValue(req.headers["x-forwarded-proto"]) ?? req.protocol ?? "https";
  const host = firstHeaderValue(req.headers["x-forwarded-host"]) ?? firstHeaderValue(req.headers.host);
  if (host) return `${proto}://${host}`;
  const root = process.env.PLATFORM_ROOT_DOMAIN;
  return root ? `https://${root}` : "";
}

/** URL absoluta a partir da origem do request; cai em caminho relativo sem host. */
export function absoluteUrl(req: FastifyRequest, path: string): string {
  return `${requestOrigin(req)}${path}`;
}
