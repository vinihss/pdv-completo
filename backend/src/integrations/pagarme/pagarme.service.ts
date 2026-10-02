import pagarme from "pagarme";
import { db } from "../../infra/db/client.js";
import { eq } from "drizzle-orm";
import { stores } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";

/**
 * Singleton PagarMe client.
 * O client é criado lazy na primeira chamada.
 * Usa a API key do Pagar.me via PAGARME_API_KEY no .env.
 */
let client: pagarme | null = null;

function getClient(): pagarme {
  if (!client) {
    const testMode = process.env.PAGARME_TEST_MODE === "true";
    if (testMode) console.log("[pagarme] MODO TESTE (sandbox) — transações NÃO são reais");
    client = new pagarme(process.env.PAGARME_API_KEY!);
  }
  return client;
}

/**
 * Dados de retorno da configuração de split de uma loja.
 */
export interface SplitInfo {
  splitPlatformPct: number; // % que a plataforma fica
  recipientId: string | null; // recebedor do tenant (lojista)
  configured: boolean; // tenant configurado com recipient_id válido
}

/**
 * Service wrapper for Pagar.me operations.
 * Cada operação é isolada por storeId (tenant).
 */
export const pagarmeService = {
  /**
   * Cria um pagamento isolado por tenant (store).
   * Usa `reference_id = storeId` e `metadata.store_id` para rastrear no Pagar.me.
   */
  createPayment: async (storeId: string, paymentData: any) => {
    const store = await db.query.stores.findFirst({
      where: eq(stores.id, storeId),
    });

    if (!store || !store.pagarme_recipient_id) {
      throw Errors.recipientNotConfigured();
    }

    const c = getClient();
    return c.orders.create({
      ...paymentData,
      reference_id: storeId,
      metadata: { store_id: storeId, recipient_id: store.pagarme_recipient_id },
    });
  },

  /**
   * Obtém o pagarme_recipient_id ou retorna { recipientId: null, configured: false }.
   */
  getRecipientInfo: async (storeId: string) => {
    const store = await db.query.stores.findFirst({
      where: eq(stores.id, storeId),
    });

    if (!store) {
      return { recipientId: null, configured: false };
    }

    if (!store.pagarme_recipient_id) {
      return { recipientId: null, configured: false };
    }

    return { recipientId: store.pagarme_recipient_id, configured: true };
  },

  /**
   * Retorna a configuração de split da loja: porcentagem da plataforma,
   * recipient_id do lojista e se está configurado.
   *
   * Estado de configuração = store existe E possui recipient_id definido.
   */
  getSplitInfo: async (storeId: string): Promise<SplitInfo> => {
    const store = await db.query.stores.findFirst({
      where: eq(stores.id, storeId),
    });

    if (!store) {
      return { splitPlatformPct: 0, recipientId: null, configured: false };
    }

    if (!store.pagarme_recipient_id) {
      return { splitPlatformPct: store.split_platform_percentage ?? 0, recipientId: null, configured: false };
    }

    return {
      splitPlatformPct: store.split_platform_percentage ?? 0,
      recipientId: store.pagarme_recipient_id,
      configured: true,
    };
  },

  /**
   * Cria um pagamento no Pagar.me com split automático (regra de split da
   * plataforma). O valor é dividido na hora do pagamento:
   *   - recebedor do lojista recebe `100 - split_platform_percentage` %
   *   - a plataforma recebe `split_platform_percentage` %
   *
   * O recipient_id da plataforma vem de `PLATFORM_PAGARME_RECIPIENT_ID`. Se o
   * lojista não tiver recebedor configurado, lança `recipientNotConfigured`.
   */
  createSplitPayment: async (
    storeId: string,
    amount: number,
    recipientIds: { recipient: string; percentage: number }[],
  ) => {
    const store = await db.query.stores.findFirst({
      where: eq(stores.id, storeId),
    });

    if (!store) {
      throw Errors.recipientNotConfigured();
    }

    if (!store.pagarme_recipient_id) {
      throw Errors.recipientNotConfigured();
    }

    const c = getClient();
    return c.orders.create({
      // O idempotência natural é o idempotency_key do Pagar.me + a nossa
      // referência (reference_id = storeId) — o webhook usa a combinação.
      reference_id: storeId,
      metadata: {
        store_id: storeId,
        recipient_id: store.pagarme_recipient_id,
        split: recipientIds,
      },
      amount, // em centavos
      split_rules: recipientIds.map((rule) => ({
        recipient_id: rule.recipient,
        percentage: rule.percentage,
        charge_processing_fee: true, // lojista arca com a tarifa do seu rateio
      })),
    });
  },

  /**
   * Lista pagamentos filtrados por store.
   */
  listPayments: async (storeId: string, filter?: any) => {
    const store = await db.query.stores.findFirst({
      where: eq(stores.id, storeId),
    });

    if (!store || !store.pagarme_recipient_id) {
      return [];
    }

    const c = getClient();
    const listParams = {
      limit: filter?.limit ?? 100,
      status: filter?.status,
      metadata: { store_id: storeId },
    };
    const orders = await (c as any).orders.list(listParams);
    return orders;
  },
};
