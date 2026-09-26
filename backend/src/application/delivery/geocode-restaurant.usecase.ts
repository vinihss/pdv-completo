import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { storeSettings } from "../../infra/db/schema.js";
import { NominatimGeocodingService } from "../../integrations/maps/geocoding.service.js";
import { getCache } from "../../infra/cache/index.js";
import { logAction } from "../../infra/audit-log.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";

const geocodingService = new NominatimGeocodingService();
const cache = getCache();

export async function geocodeRestaurantUsecase(): Promise<{
  latitude: number;
  longitude: number;
}> {
  const settings = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (!settings) throw new Error("store_settings não inicializado");

  const address = `${settings.merchantName}, ${settings.merchantCity}`;

  try {
    const coords = await geocodingService.forwardGeocode(address);

    db.transaction((tx) => {
      tx.update(storeSettings)
        .set({ restaurantLat: coords.latitude, restaurantLong: coords.longitude })
        .where(eq(storeSettings.id, "singleton"))
        .run();
      logAction(tx, SYSTEM_USER_ID, "restaurant_geocoded", null, { latitude: coords.latitude, longitude: coords.longitude });
    });

    cache.invalidate("store-settings:singleton");

    return coords;
  } catch (err) {
    throw new Error("Não foi possível geocodificar o endereço do restaurante");
  }
}
