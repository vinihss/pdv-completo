import { eq } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { storeSettings } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";

function serialize(s: typeof storeSettings.$inferSelect) {
  return {
    merchantName: s.merchantName,
    merchantCity: s.merchantCity,
    pixKey: s.pixKey,
    pixKeyType: s.pixKeyType,
    usesTables: s.usesTables,
    kitchenEnabled: s.kitchenEnabled,
    enabledPaymentMethods: JSON.parse(s.enabledPaymentMethods),
    kitchenPrepWarnMin: s.kitchenPrepWarnMin,
    kitchenPrepUrgentMin: s.kitchenPrepUrgentMin,
    kitchenPickupUrgentMin: s.kitchenPickupUrgentMin,
    deliveryFee: s.deliveryFee,
  };
}

export async function getStoreSettingsUsecase() {
  const s = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (!s) throw Errors.notFound("Configuração da loja");
  return serialize(s);
}

export async function updateStoreSettingsUsecase(input: {
  merchantName: string;
  merchantCity: string;
  pixKey: string;
  pixKeyType: "cpf" | "cnpj" | "email" | "phone" | "random";
  usesTables: boolean;
  kitchenEnabled: boolean;
  enabledPaymentMethods: string[];
  kitchenPrepWarnMin: number;
  kitchenPrepUrgentMin: number;
  kitchenPickupUrgentMin: number;
  deliveryFee: number;
}) {
  if (input.merchantName.length > 25) throw Errors.validationFailed({ field: "merchantName", max: 25 });
  if (input.merchantCity.length > 15) throw Errors.validationFailed({ field: "merchantCity", max: 15 });
  if (input.kitchenPrepUrgentMin <= input.kitchenPrepWarnMin) throw Errors.invalidKitchenThresholds();

  const [updated] = await db
    .update(storeSettings)
    .set({
      merchantName: input.merchantName,
      merchantCity: input.merchantCity,
      pixKey: input.pixKey,
      pixKeyType: input.pixKeyType,
      usesTables: input.usesTables,
      kitchenEnabled: input.kitchenEnabled,
      enabledPaymentMethods: JSON.stringify(input.enabledPaymentMethods),
      kitchenPrepWarnMin: input.kitchenPrepWarnMin,
      kitchenPrepUrgentMin: input.kitchenPrepUrgentMin,
      kitchenPickupUrgentMin: input.kitchenPickupUrgentMin,
      deliveryFee: input.deliveryFee,
    })
    .where(eq(storeSettings.id, "singleton"))
    .returning();

  return serialize(updated);
}
