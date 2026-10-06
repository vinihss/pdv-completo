import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../../domain/errors.js";
import { publicLookupRateLimit } from "../middlewares/rate-limit.middleware.js";
import { getPublicTenantUsecase } from "../../application/tenant/resolve-tenant.usecase.js";

/**
 * `GET /public/tenants/resolve?host=<hostname>` — a vitrine de pedidos
 * (`apps/pedido-public`) descobre em qual loja está antes de qualquer outra
 * chamada. Sem autenticação por desenho: é a primeira tela do cliente final, e
 * a resposta é o nome/logo/cor da loja — o mesmo que `/store-info` já expõe.
 *
 * ⚠️ O path é `/public/tenants/resolve`, **sem** `/api`: o Caddy faz
 * `uri strip_prefix /api` no bloco `(site)` (`deploy/Caddyfile:27-30`), e o
 * bloco `api.${ROOT_DOMAIN}` (linha 124) faz proxy sem mexer em path. As duas
 * entradas do Caddy chegam aqui como `/public/tenants/resolve` — igual a
 * `/public/menu` e a `/store-info`.
 *
 * De onde vem o host, em ordem:
 *  1. `?host=` — é assim que a SPA chama. Necessário porque na API o `Host` é
 *     `api.seudominio.com.br`, que não identifica loja: o Caddy injeta
 *     `X-Tenant-Host` com o host DA API (`header_up X-Tenant-Host {host}`,
 *     `deploy/Caddyfile:125`), e `api.` é rótulo reservado.
 *  2. `X-Tenant-Host` — o header que o Caddy injeta. Vale como fallback; num
 *     `api.*` ele traz o host da API, que resolve para o tenant default.
 *  3. `Host`/`X-Forwarded-Host` — a autoridade natural (§4.8), que é o que
 *     resolve quando a chamada vem do wildcard `*.seudominio.com.br` servindo
 *     a própria vitrine.
 *
 * O host é **entrada do cliente** e por isso nunca vira identificador de banco:
 * ele só serve para PROCURAR no registry (`public.tenant`), e o `schema_name`
 * que sai de lá é o único que o resto do backend usa (e ele nunca volta na
 * resposta).
 */
const tenantRoutes = async (app: FastifyInstance) => {
  app.get("/public/tenants/resolve", { preHandler: publicLookupRateLimit }, async (req, reply) => {
    const host = requestedHost(req);

    try {
      const tenant = await getPublicTenantUsecase(host);
      return reply.code(200).send({ found: true, tenant });
    } catch (err) {
      if (err instanceof AppError && err.status === 404) {
        // 404 é o resultado ESPERADO deste endpoint (a tela do cliente final cai
        // em "Loja não encontrada"), então o corpo leva `found: false` — que é
        // o contrato de `apps/pedido-public/src/app/providers/tenant-provider.tsx`
        // — junto com o envelope de erro padrão do projeto, para o resto do app
        // (e para o log) continuar lendo `error.code`.
        return reply
          .code(404)
          .send({ found: false, error: { code: err.code, message: err.message, details: err.details } });
      }
      throw err;
    }
  });
};

/** Query → header injetado pelo Caddy → host da requisição (trustProxy). */
function requestedHost(req: FastifyRequest): string | undefined {
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.host;
  if (typeof fromQuery === "string" && fromQuery.trim() !== "") return fromQuery;

  const headers = req.headers;
  const injected = headers["x-tenant-host"];
  if (typeof injected === "string" && injected.trim() !== "") return injected;

  // `req.hostname` já respeita `trustProxy` (o app sobe com `trustProxy: true`),
  // ou seja, prefere `X-Forwarded-Host` ao `Host` quando o header existe.
  return req.hostname || undefined;
}

export { tenantRoutes };
