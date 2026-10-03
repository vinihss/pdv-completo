import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { storeSettings } from "../../infra/db/schema.js";
import { NominatimGeocodingService } from "../../integrations/maps/geocoding.service.js";
import { getCache } from "../../infra/cache/index.js";
import { logAction } from "../../infra/audit-log.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";

const geocodingService = new NominatimGeocodingService();
const cache = getCache();

/**
 * Geocoda o endereço do restaurante e grava as coordenadas em `store_settings`.
 *
 * `storeId` é explícito porque as settings são por tenant desde a migration
 * 0011 (antes era o singleton fixo): a rota repassa `req.storeId` — sem ela a
 * coordenada cairia na loja errada.
 */
export async function geocodeRestaurantUsecase(storeId: string): Promise<{
  latitude: number;
  longitude: number;
}> {
  const settings = await db.query.storeSettings.findFirst({ where: eq(storeSettings.storeId, storeId) });
  if (!settings) throw new Error("store_settings não inicializado para esta store.");

  const address = `${settings.merchantName}, ${settings.merchantCity}`;

  try {
    const coords = await geocodingService.forwardGeocode(address);

    await db.transaction(async (tx) => {
      await tx
        .update(storeSettings)
        .set({ restaurantLat: coords.latitude, restaurantLong: coords.longitude })
        .where(eq(storeSettings.storeId, storeId));
      await logAction(tx, SYSTEM_USER_ID, "restaurant_geocoded", null, { latitude: coords.latitude, longitude: coords.longitude });
    });

    cache.invalidate(`store-settings:${storeId}`);

    return coords;
  } catch (err) {
    throw new Error("Não foi possível geocodificar o endereço do restaurante");
  }
}
