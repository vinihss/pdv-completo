import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { ifoodState } from "../../infra/db/schema.js";

// Acesso ao KV ifood_state (token, merchantId, timestamps). Tudo é async
// porque o banco oficial é Postgres (node-postgres) — ver a nota em
// application/order/order.usecases.ts.

export async function getIfoodState(key: string): Promise<string | undefined> {
  const [row] = await db
    .select({ value: ifoodState.value })
    .from(ifoodState)
    .where(eq(ifoodState.key, key));
  return row?.value;
}

export async function setIfoodState(key: string, value: string): Promise<void> {
  await db
    .insert(ifoodState)
    .values({ key, value })
    .onConflictDoUpdate({ target: ifoodState.key, set: { value, updatedAt: new Date().toISOString() } });
}

export async function clearIfoodState(key: string): Promise<void> {
  await db.delete(ifoodState).where(eq(ifoodState.key, key));
}

// Helpes tipados pro que o restante da integração usa.
export const ifoodStateKeys = {
  accessToken: "accessToken",
  tokenExpiresAt: "tokenExpiresAt", // epoch ms
  merchantId: "merchantId",
  merchantName: "merchantName",
  lastPollAt: "lastPollAt",
  lastPollError: "lastPollError",
  lastCatalogSyncAt: "lastCatalogSyncAt",
  lastCatalogSyncError: "lastCatalogSyncError",
} as const;

export async function getMerchantId(): Promise<string | undefined> {
  return getIfoodState(ifoodStateKeys.merchantId);
}
export async function setMerchantId(merchantId: string, merchantName?: string): Promise<void> {
  await setIfoodState(ifoodStateKeys.merchantId, merchantId);
  if (merchantName) await setIfoodState(ifoodStateKeys.merchantName, merchantName);
}

// Resolve o merchant uma vez (env IFOOD_MERCHANT_ID ou listagem via /merchants)
// e guarda no KV — tokens do iFood já vêm com o escopo dos merchants
// autorizados, então só precisamos do id pra montar as URLs de catálogo.
export async function resolveMerchantIfNeeded(): Promise<void> {
  if (await getMerchantId()) return;
  const { resolveMerchantId } = await import("./client.js");
  const merchant = await resolveMerchantId();
  if (merchant) await setMerchantId(merchant.id, merchant.name);
}