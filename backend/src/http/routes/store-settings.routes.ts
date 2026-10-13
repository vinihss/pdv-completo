/**
 * Rotas de configurações da loja (store settings + geocodificação do
 * endereço do estabelecimento).
 *
 * Endpoints:
 *   GET    /store-settings           — obter configurações
 *   PUT    /store-settings           — atualizar configurações (manager)
 *   POST   /store-settings/logo      — upload de logo (manager)
 *   DELETE /store-settings/logo      — remover logo (manager)
 *   POST   /store/geocode-restaurant — geocodificar endereço (manager)
 *
 * Use cases: `backend/src/application/` (store-settings, delivery/geocode-restaurant)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../../domain/errors.js";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { ensureTenantScope } from "../../infra/db/tenant-context.js";
import { getStoreSettingsUsecase, updateStoreSettingsUsecase, saveStoreLogoUsecase, clearStoreLogoUsecase } from "../../application/store-settings.usecases.js";
import { geocodeRestaurantUsecase } from "../../infra/composition/default-usecases.js";
import { imageExtByMime } from "./image-ext.js";

const storeSettingsSchema = z.object({
  merchantName: z.string(),
  merchantCity: z.string(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  pixKey: z.string(),
  pixKeyType: z.enum(["cpf", "cnpj", "email", "phone", "random"]),
  usesTables: z.boolean(),
  kitchenEnabled: z.boolean(),
  usesDelivery: z.boolean(),
  ifoodIntegrationEnabled: z.boolean(),
  // Opcional (expand/contract): um frontend antigo não envia o campo e não
  // pode ligar/desligar a integração por acidente — o usecase mantém o valor.
  inventoryEnabled: z.boolean(),
  purchaseEnabled: z.boolean(),
  printerEnabled: z.boolean(),
  printerAutoPrint: z.boolean(),
  enabledPaymentMethods: z.array(z.enum(["cash", "card", "pix", "other"])),
  kitchenPrepWarnMin: z.number().int().positive(),
  kitchenPrepUrgentMin: z.number().int().positive(),
  kitchenPickupUrgentMin: z.number().int().positive(),
  deliveryFee: z.number().min(0),
  restaurantLat: z.number().min(-90).max(90).optional().nullable(),
  restaurantLong: z.number().min(-180).max(180).optional().nullable(),
  freeDeliveryMin: z.number().min(0).optional(),
  deliveryFeeTiers: z.array(z.object({ maxKm: z.number().positive(), fee: z.number().min(0) })).optional(),
  deliveryPrepMinutes: z.number().int().positive().optional(),
  minutesPerKm: z.number().min(0).optional(),
});

export async function storeSettingsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Store settings ----------
  app.get("/store-settings", async (req) => {
    const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
    return ensureTenantScope(host, () => getStoreSettingsUsecase());
  });
  app.put("/store-settings", { preHandler: requireRole("manager") }, async (req) => {
    const body = storeSettingsSchema.parse(req.body);
    const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
    return ensureTenantScope(host, () => updateStoreSettingsUsecase(body));
  });
  // Logo — upload multipart (multipart/form-data, campo "logo")
  app.post("/store-settings/logo", { preHandler: requireRole("manager") }, async (req) => {
    const file = await req.file();
    if (!file) throw Errors.validationFailed({ field: "logo" });
    const ext = imageExtByMime[file.mimetype];
    if (!ext) throw Errors.validationFailed({ field: "logo" });
    const buffer = await file.toBuffer();
    return saveStoreLogoUsecase({ buffer, ext }, req.authUser!.sub);
  });
  // Logo — remover
  app.delete("/store-settings/logo", { preHandler: requireRole("manager") }, async (req) => {
    return clearStoreLogoUsecase(req.authUser!.sub);
  });
  // Geocodificar restaurante (forward geocoding do endereço do estabelecimento)
  app.post("/store/geocode-restaurant", { preHandler: requireRole("manager") }, async (req) => {
    return geocodeRestaurantUsecase();
  });
}
