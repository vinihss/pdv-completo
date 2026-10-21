/**
 * SEAM — o TENANT do storage. Única função do backend que decide de qual
 * loja é a operação de arquivo.
 *
 * O diretório é por `tenantId` (o uuid da loja), não por schema: no modelo
 * por linha (`docs/28`) o schema é um só, e o id é a identidade estável (o
 * slug pode ser renomeado). O `AsyncLocalStorage` — populado no `onRequest`
 * a partir do subdomínio — diz qual é a loja; sem request no ar (jobs, seed),
 * é o default implícito.
 */
import { currentTenantId } from "../db/tenant-context.js";

export function resolveTenant(): string {
  return currentTenantId();
}
