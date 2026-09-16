import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { ifoodState } from "../../infra/db/schema.js";

// Acesso ao KV ifood_state (token, merchantId, timestamps). Transações do
// Drizzle + better-sqlite3 são síncronas: usar .get()/.run() (ver AGENTS.md).

export function getIfoodState(key: string): string | undefined {
  const row = db
    .select({ value: ifoodState.value })
    .from(ifoodState)
    .where(eq(ifoodState.key, key))
    .get();
  return row?.value;
}

export function setIfoodState(key: string, value: string): void {
  db.insert(ifoodState)
    .values({ key, value })
    .onConflictDoUpdate({ target: ifoodState.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

export function clearIfoodState(key: string): void {
  db.delete(ifoodState).where(eq(ifoodState.key, key)).run();
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

export function getMerchantId(): string | undefined {
  return getIfoodState(ifoodStateKeys.merchantId);
}
export function setMerchantId(merchantId: string, merchantName?: string): void {
  setIfoodState(ifoodStateKeys.merchantId, merchantId);
  if (merchantName) setIfoodState(ifoodStateKeys.merchantName, merchantName);
}

// Resolve o merchant uma vez (env IFOOD_MERCHANT_ID ou listagem via /merchants)
// e guarda no KV — tokens do iFood já vêm com o escopo dos merchants
// autorizados, então só precisamos do id pra montar as URLs de catálogo.
export async function resolveMerchantIfNeeded(): Promise<void> {
  if (getMerchantId()) return;
  const { resolveMerchantId } = await import("./client.js");
  const merchant = await resolveMerchantId();
  if (merchant) setMerchantId(merchant.id, merchant.name);
}