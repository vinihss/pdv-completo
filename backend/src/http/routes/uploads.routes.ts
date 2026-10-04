import type { FastifyInstance, FastifyReply } from "fastify";
import {
  getStorage,
  isSafeFilename,
  isServableFilename,
  isStorageKind,
  type StorageKind,
} from "../../infra/storage/index.js";

/**
 * `GET /uploads/:kind/:filename` — substitui o `@fastify/static`.
 *
 * O `@fastify/static` era um diretório flat servido por uma rota pública do
 * escopo raiz: nenhum isolamento, e `logo.png` (nome fixo) era sobrescrito por
 * qualquer loja. Aqui o tenant é resolvido **dentro** da rota (seam em
 * `infra/storage/tenant.ts`) e o layout em disco é por tenant, então:
 *
 * - a URL da loja A **dá 404 na loja B** por construção — o schema não é
 *   segmento da URL, é o diretório de onde os bytes são lidos;
 * - `kind` sai de uma whitelist e `filename` precisa passar no `isSafeFilename`
 *   (sem `..`, sem barra, sem caminho absoluto), com `nosniff` na resposta;
 * - `/uploads/` continua o prefixo público — o `deploy/Caddyfile` e o volume
 *   `pdv_backend_uploads` não mudam.
 */
const uploadsRoutes = async (app: FastifyInstance) => {
  /**
   * Cache: foto de produto/cliente/usuário tem nome derivado do id (uuid), então
   * a URL muda quando a extensão muda → `immutable`. Logo é sobrescrito no lugar
   * (nome fixo `logo.<ext>`) → sempre revalidar.
   *
   * ⚠️ Consequência conhecida: reenviar a foto **com a mesma extensão** regrava o
   * mesmo nome, e um browser que já cacheou com `immutable` só mostra a nova
   * depois de hard reload. Se isso incomodar, o conserto é `no-cache` nos três
   * kinds (revalidação por ETag: ~304 em vez de bytes) — uma linha neste mapa.
   */
  const CACHE_BY_KIND: Record<StorageKind, string> = {
    product: "public, max-age=31536000, immutable",
    customer: "public, max-age=31536000, immutable",
    user: "public, max-age=31536000, immutable",
    logo: "no-cache",
  };

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Arquivo não encontrado." } });

  app.get("/uploads/:kind/:filename", async (req, reply) => {
    const { kind, filename } = req.params as { kind: string; filename: string };

    // 404 (e não 400) para `kind` desconhecido: a URL pública não deve revelar
    // quais domínios de arquivo existem.
    if (!isStorageKind(kind) || !isSafeFilename(filename) || !isServableFilename(filename)) {
      return notFound(reply);
    }

    const object = await getStorage().get(kind, filename);
    if (!object) return notFound(reply);

    reply.header("content-type", object.contentType);
    reply.header("content-length", object.size);
    reply.header("cache-control", CACHE_BY_KIND[kind]);
    // Sem isto, um conteúdo que o browser sniffe como HTML vira XSS no domínio
    // da loja. As extensões servíveis são só as do upload, mas a header
    // fecha a classe inteira.
    reply.header("x-content-type-options", "nosniff");
    if (object.etag) reply.header("etag", object.etag);
    if (object.lastModified) reply.header("last-modified", object.lastModified.toUTCString());

    if (object.etag && req.headers["if-none-match"] === object.etag) {
      return reply.code(304).send();
    }
    return reply.send(object.body);
  });
};

export { uploadsRoutes };
