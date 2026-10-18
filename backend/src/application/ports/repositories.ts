/**
 * Ports de repositório (persistência) e de efeitos transacionais — FASE 0 da
 * refatoração arquitetural. Contrato CONGELADO: os use cases migrados falam
 * com estas interfaces; os adapters Postgres (`src/infra/db/repositories/`)
 * traduzem para Drizzle/schema.
 *
 * ATENÇÃO: este arquivo é só BARREL. O histórico era um monólito de ~1,5k
 * linhas; primeiro foi separado por domínio em `./repositories/<dominio>.ts`
 * (espelho do split do lado infra) e agora os ports de dono CLARO vivem
 * CO-LOCALIZADOS no módulo dono:
 *
 *   - `<modulo>/ports/<modulo>-repository.ts` — o port do repositório do
 *     domínio (order, customer, user, stock, cash-flow, purchase, refund,
 *     delivery, store-settings, alert, provisioning, report, self-service);
 *   - `repositories/catalog.ts` — FICA AQUI: o catálogo (produtos, categorias,
 *     grupos de produção, mesas) atende vários módulos (product, category,
 *     kitchen-group e o próprio order) — não tem dono único;
 *   - `repositories/audit.ts`/`outbox.ts` — FICAM AQUI: audit/outbox são
 *     efeitos da MESMA transação que TODO use case usa via `TenantSession`;
 *   - `repositories/shared.ts` — tipos primitivos e unions usados por mais de
 *     um domínio.
 *
 * Onde mexer:
 *   - contrato de um domínio → `ports/` do módulo dono (ou aqui, se não tem
 *     dono único: catalog/audit/outbox/shared);
 *   - dependências injetadas de um módulo → `<modulo>/ports/<modulo>-dependencies.ts`;
 *   - semântica/implementação → `infra/db/repositories/<dominio>.repository.ts`.
 *
 * Campos de apresentação (URL de foto, nomes de categoria resolvidos, etc.) NÃO
 * entram no record: quem serializa é o use case. As notas de adaptação ao
 * modelo real (`AuditWriter` com `orderId`, `OutboxWriter` com `room`) moram
 * nos arquivos dos respectivos domínios (`audit.ts`/`outbox.ts`).
 */

// ---------- sem dono único (catálogo, efeitos transacionais, tipos base) ----------
export * from "./repositories/shared.js";
export * from "./repositories/catalog.js";
export * from "./repositories/audit.js";
export * from "./repositories/outbox.js";

// ---------- co-localizados nos módulos donos ----------
export * from "../order/ports/order-repository.js";
export * from "../customer/ports/customer-repository.js";
export * from "../self-service/ports/customer-self-service-repository.js";
export * from "../user/ports/user-repository.js";
export * from "../stock/ports/stock-repository.js";
export * from "../cash-flow/ports/cash-flow-repository.js";
export * from "../purchase/ports/purchase-repository.js";
export * from "../purchase/ports/supplier-repository.js";
export * from "../refund/ports/refund-repository.js";
export * from "../delivery/ports/delivery-repository.js";
export * from "../delivery/ports/courier-location-repository.js";
export * from "../store-settings/ports/store-settings-repository.js";
export * from "../alert/ports/alert-repository.js";
export * from "../provisioning/ports/provisioning-repository.js";
export * from "../report/ports/report-repository.js";
export * from "../identity/ports/identity-repository.js";
