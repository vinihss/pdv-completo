// Carrinho server-side do cliente — continuação do pedido sem localStorage.
// Cliente que fechou/reload no meio do checkout reabre o link (o telefone
// já vem nele, via whatsapp-bot.usecases.ts#buildMenuLink) e continua de
// onde parou. Chaveado pelo telefone — mesma chave de identificação do
// fluxo self-service; isolado por telefone (dois aparelhos não misturam).
//
// Sem validação de produto/estoque aqui: é rascunho — a validação acontece
// no submit (createSelfServiceOrderUsecase → addItemsUsecase). Mesmo
// desenho previsto no §04 (whatsapp_conversation.cart_items, hoje não
// usado) — tabela dedicada pra não acoplar carrinho ao estado da conversa.
import { eq, lt } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { customerCarts } from "../../infra/db/schema.js";

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

// Retorno null = carrinho inexistente ou expirado (expirado é purgado na leitura).
export async function getCustomerCartUsecase(phone: string): Promise<CartItemDraft[] | null> {
  const row = await db.query.customerCarts.findFirst({ where: eq(customerCarts.phone, phone) });
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    await db.delete(customerCarts).where(eq(customerCarts.phone, phone));
    return null;
  }
  return parseItems(row.items);
}

// Upsert por telefone — last-write-wins (rascunho, sem idempotência:
// o PUT do client é debounced e a validação de verdade acontece no submit).
export async function saveCustomerCartUsecase(phone: string, items: CartItemDraft[]): Promise<void> {
  const now = new Date();
  const values = {
    items: JSON.stringify(items),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CART_TTL_MS).toISOString(),
  };
  await db
    .insert(customerCarts)
    .values({ phone, ...values })
    .onConflictDoUpdate({ target: customerCarts.phone, set: values });
}

export async function clearCustomerCartUsecase(phone: string): Promise<void> {
  await db.delete(customerCarts).where(eq(customerCarts.phone, phone));
}
