import { eq, isNull, or, type SQL } from "drizzle-orm";
import { users } from "../../infra/db/schema.js";
import { DEFAULT_STORE_ID } from "../../domain/constants.js";

/**
 * Escopo de loja da identidade de usuário — compartilhado por
 * `GET /auth/users` (tela de seleção do login, pública) e pelo
 * `POST /auth/login` (application/auth/login.usecase).
 *
 * Sem isto a tela de login vaza nomes/fotos/papéis de TODAS as lojas pra
 * qualquer visitante do subdomínio de uma loja, e um PIN válido da loja B
 * logava pela superfície da loja A.
 *
 * ## Decisão sobre `user.store_id NULL`
 *
 * A coluna nasceu nullable (0008: `TEXT REFERENCES stores(id) ON DELETE SET
 * NULL`) e o backfill da própria 0008 apontou tudo que existia para a store
 * default — ou seja, NULL sempre significou "dado legado da loja default",
 * nunca "sem loja". Decisão adotada aqui: **`store_id NULL` só pertence à
 * store default** (`DEFAULT_STORE_ID`).
 *
 *   - É a mesma semântica do backfill da 0008 (fail-closed: o dado antigo não
 *     vaza para lojas novas);
 *   - usuário legado sem store deixa de ser visível/autenticável fora da
 *     loja default, em vez de vazar pra todo mundo;
 *   - contrapartida conhecida: `createUserUsecase` ainda grava `store_id`
 *     NULL (fora do escopo deste PR) — até isso ser corrigido, usuário criado
 *     por uma loja que NÃO é a default só aparece na tela de login da default.
 *     Enquanto o produto roda com a loja default como base, nada quebra.
 */

/**
 * O usuário pertence à loja resolvida do request?
 *
 * `userStoreId` = `user.store_id` (nullable); `storeId` = loja resolvida pelo
 * tenant middleware (`req.storeId`). Resposta NUNCA vaza o motivo — quem
 * chama deve responder com o erro genérico de credenciais.
 */
export function belongsToStore(userStoreId: string | null, storeId: string): boolean {
  if (userStoreId !== null && userStoreId !== undefined) return userStoreId === storeId;
  return storeId === DEFAULT_STORE_ID;
}

/**
 * Filtro Drizzle `WHERE` de loja para a lista de usuários do login.
 *
 * Só o escopo de loja — quem chama continua aplicando `users.active = true`
 * (junto, com `and`). Na store default entra também `store_id IS NULL` (ver
 * decisão acima); em qualquer outra loja é igualdade estrita — NULL não cai
 * nela.
 */
export function usersOfStoreFilter(storeId: string): SQL | undefined {
  if (storeId === DEFAULT_STORE_ID) return or(eq(users.storeId, storeId), isNull(users.storeId));
  return eq(users.storeId, storeId);
}
