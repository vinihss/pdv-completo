/**
 * Ports de repositório (persistência) e de efeitos transacionais — FASE 0 da
 * refatoração arquitetural. Contrato CONGELADO: os use cases migrados falam
 * com estas interfaces; os adapters Postgres (`src/infra/db/repositories/`)
 * traduzem para Drizzle/schema.
 *
 * ATENÇÃO: este arquivo é só BARREL. O histórico era um monólito de ~1,5k
 * linhas com todos os contratos; cada domínio foi separado em
 * `./repositories/<dominio>.ts` (imports relativos internos) e reexportado
 * (aqui), para não mexer no import de nenhum consumidor — o espelho exato do
 * split do lado infra (`infra/db/postgres-repositories.ts` →
 * `infra/db/repositories/<dominio>.repository.ts`).
 *
 * Onde mexer:
 *   - contrato de um domínio → `repositories/<dominio>.ts`;
 *   - port de domínio novo → crie `repositories/<dominio>.ts` e adicione o
 *     `export *` abaixo;
 *   - tipos/unions compartilhados → `repositories/shared.ts`;
 *   - semântica/implementação → `infra/db/repositories/<dominio>.repository.ts`.
 *
 * Campos de apresentação (URL de foto, nomes de categoria resolvidos, etc.) NÃO
 * entram no record: quem serializa é o use case. As notas de adaptação ao
 * modelo real (`AuditWriter` com `orderId`, `OutboxWriter` com `room`) moram
 * agora nos arquivos dos respectivos domínios (`audit.ts`/`outbox.ts`).
 */

export * from "./repositories/shared.js";
export * from "./repositories/catalog.js";
export * from "./repositories/customer.js";
export * from "./repositories/customer-self-service.js";
export * from "./repositories/user.js";
export * from "./repositories/order.js";
export * from "./repositories/stock.js";
export * from "./repositories/cash-flow.js";
export * from "./repositories/supplier.js";
export * from "./repositories/purchase.js";
export * from "./repositories/refund.js";
export * from "./repositories/delivery.js";
export * from "./repositories/courier-location.js";
export * from "./repositories/store-settings.js";
export * from "./repositories/alert.js";
export * from "./repositories/provisioning.js";
export * from "./repositories/audit.js";
export * from "./repositories/outbox.js";
export * from "./repositories/report.js";
