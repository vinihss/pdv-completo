import { db } from "../../src/infra/db/client.js";
import { storeSettings } from "../../src/infra/db/schema.js";

type InsertStoreSettings = typeof storeSettings.$inferInsert;
type SelectStoreSettings = typeof storeSettings.$inferSelect;

export async function createStoreSettings(
  overrides: Partial<InsertStoreSettings> = {},
): Promise<SelectStoreSettings> {
  const settings: InsertStoreSettings = {
    id: "singleton",
    merchantName: overrides.merchantName ?? "Teste Café",
    merchantCity: overrides.merchantCity ?? "Sao Paulo",
    enabledPaymentMethods: overrides.enabledPaymentMethods ?? JSON.stringify(["cash", "card", "pix", "other"]),
    usesDelivery: overrides.usesDelivery ?? false,
    usesTables: overrides.usesTables ?? true,
    kitchenEnabled: overrides.kitchenEnabled ?? true,
    inventoryEnabled: overrides.inventoryEnabled ?? false,
    purchaseEnabled: overrides.purchaseEnabled ?? false,
    cashClosingTolerance: overrides.cashClosingTolerance ?? 0,
    cashClosingRequireApprovalAbove: overrides.cashClosingRequireApprovalAbove ?? 1000,
    cashHighValueThreshold: overrides.cashHighValueThreshold ?? 10000,
    ...overrides,
  };

  await db
    .insert(storeSettings)
    .values(settings)
    .onConflictDoUpdate({
      target: storeSettings.id,
      set: settings,
    });

  return settings as SelectStoreSettings;
}
