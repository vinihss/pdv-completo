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
   * Cache: o nome do arquivo é ESTÁVEL e o conteúdo pode mudar na mesma URL
   * → por isso `no-cache` em todos os kinds. O raciocínio antigo ("o nome
   * vem de um uuid, então é imutável") está errado: o uuid é do recurso
   * LÓGICO (id do produto, do cliente, do usuário), não do conteúdo.
   * Reenviar a foto do mesmo produto/cliente/usuário regrava o mesmo
   * `<uuid>.<ext>`; o logo troca o conteúdo em `logo.<ext>` a cada save.
   * Com `immutable`, um browser que já cacheou a URL NUNCA revalidaria e
   * só mostraria o novo depois de hard reload.
   *
   * O mecanismo de revalidação barato segue ativo: `no-cache` exige
   * revalidar a cada uso, e o ETag fraco (tamanho+mtime) devolve 304
   * quando o conteúdo não mudou — a resposta é "revalide sempre, mas a
   * revalidação custa quase nada".
   */
  const CACHE_BY_KIND: Record<StorageKind, string> = {
    product: "no-cache",
    customer: "no-cache",
    user: "no-cache",
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
