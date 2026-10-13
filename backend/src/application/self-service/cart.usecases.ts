// Carrinho server-side do cliente — ONDA 3 da refatoração arquitetural.
//
// Este arquivo é uma FACTORY pura (`createCartUsecases(deps)`): nenhuma
// importação de infra/integrations/config nem Drizzle. A persistência passa
// pelo `uow.run`/`session.customerCarts` (tabela `customer_cart`, desacoplada
// do pedido). A composition root que liga o adapter concreto é
// `src/infra/composition/default-usecases.ts`.
//
// Carrinho server-side — continuação do pedido sem localStorage. Cliente que
// fechou/reload no meio do checkout reabre o link (o telefone já vem nele) e
// continua de onde parou. Chaveado pelo telefone — mesma chave de
// identificação do fluxo self-service; isolado por telefone (dois aparelhos
// não misturam).
//
// Sem validação de produto/estoque aqui: é rascunho — a validação acontece no
// submit (createSelfServiceOrderUsecase → addItemsUsecase).
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2): cada leitura/escrita roda numa
// única janela `uow.run`, inclusive a purga do carrinho expirado (delete na
// mesma transação da leitura).
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";

const CART_TTL_MS = 24 * 60 * 60_000; // 24h — sobrevive ao ciclo do dia; purga no job de maintenance

// Shape do rascunho — espelha o body de POST /public/orders (items).
export type CartItemDraft = {
  productId: string;
  quantity: number;
  selectedVariations?: Record<string, string | string[]>;
  notes?: string;
};

function parseItems(raw: string): CartItemDraft[] {
  // items é text no Postgres (drizzle sem mode:'json') — parse defensivo.
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface CartUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

/**
 * As 3 use cases do carrinho, com as MESMAS assinaturas de antes (sem o
 * `deps`). Os nomes legados (`getCustomerCartUsecase(phone)` etc.) são
 * re-exportados por `infra/composition/default-usecases.ts`.
 */
export function createCartUsecases(deps: CartUsecasesDeps) {
  return {
    // Retorno null = carrinho inexistente ou expirado (expirado é purgado na leitura).
    async getCustomerCartUsecase(phone: string): Promise<CartItemDraft[] | null> {
      return deps.uow.run(deps.tenant(), async (session) => {
        const row = await session.customerCarts.findByPhone(phone);
        if (!row) return null;
        if (new Date(row.expiresAt).getTime() <= Date.now()) {
          await session.customerCarts.deleteByPhone(phone);
          return null;
        }
        return parseItems(row.items);
      });
    },

    // Upsert por telefone — last-write-wins (rascunho, sem idempotência:
    // o PUT do client é debounced e a validação de verdade acontece no submit).
    async saveCustomerCartUsecase(phone: string, items: CartItemDraft[]): Promise<void> {
      const now = new Date();
      await deps.uow.run(deps.tenant(), async (session) => {
        await session.customerCarts.upsert({
          phone,
          items: JSON.stringify(items),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + CART_TTL_MS).toISOString(),
        });
      });
    },

    async clearCustomerCartUsecase(phone: string): Promise<void> {
      await deps.uow.run(deps.tenant(), async (session) => {
        await session.customerCarts.deleteByPhone(phone);
      });
    },
  };
}

export type CartUsecases = ReturnType<typeof createCartUsecases>;
