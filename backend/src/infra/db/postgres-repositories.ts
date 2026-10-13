/**
 * Implementações Postgres dos repositórios — adapters da FASE 0.
 *
 * ATENÇÃO: este arquivo é só BARREL. O histórico era um monolito de ~3,3k
 * linhas com todos os adapters; cada domínio foi separado em
 * `./repositories/<dominio>.repository.ts` (imports relativos internos) e
 * reexportado (aqui), para não mexer no import do composition root
 * (`./postgres-session.ts`) nem de nenhum consumidor.
 *
 * Onde mexer:
 *   - implementação de um domínio → `repositories/<dominio>.repository.ts`;
 *   - adapter de um domínio novo → crie `repositories/<dominio>.repository.ts`
 *     e adicione o `export *` abaixo;
 *   - contrato (port) e semântica → `application/ports/repositories.ts`.
 *
 * O que os adapters NÃO fazem: audit/outbox (quem chama é o use case, via
 * `session.audit`/`session.outbox`), cache/storage (`TenantCache`, arquivos) e
 * as validações de domínio além das óbvias — essas continuam no use case.
 */

export * from "./repositories/alert.repository.js";
export * from "./repositories/audit.repository.js";
export * from "./repositories/cash-flow.repository.js";
export * from "./repositories/catalog.repository.js";
export * from "./repositories/courier-location.repository.js";
export * from "./repositories/customer.repository.js";
export * from "./repositories/customer-self-service.repository.js";
export * from "./repositories/delivery.repository.js";
export * from "./repositories/order.repository.js";
export * from "./repositories/outbox.repository.js";
export * from "./repositories/provisioning.repository.js";
export * from "./repositories/purchase.repository.js";
export * from "./repositories/refund.repository.js";
export * from "./repositories/report.repository.js";
export * from "./repositories/stock.repository.js";
export * from "./repositories/store-settings.repository.js";
export * from "./repositories/supplier.repository.js";
export * from "./repositories/user.repository.js";
