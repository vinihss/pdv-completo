// Geocodificação do endereço do restaurante — ONDA 3 da refatoração.
//
// FACTORY pura (`createDeliveryUsecases` em `calcular-entrega.usecase.ts`):
// nada de infra/integrations/Drizzle aqui. A escrita em `store_settings` vai
// pelo `uow.run` → `session.storeSettings`, o audit pela mesma transação
// (`session.audit`) e o forward geocoding pelo effect port `GeocodingService`.
// A composition root que liga os adapters é
// `src/infra/composition/default-usecases.ts`.
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2): a leitura do singleton (antes
// `db.query.storeSettings`, fora do tx) e a escrita (antes um
// `db.transaction` próprio) agora acontecem em janelas `uow.run`.
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import type { GeocodingService, StoreSettingsReader, TenantCache } from "../ports/effects.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";

export interface GeocodeRestaurantDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  settings: StoreSettingsReader;
  /** Cache por schema — invalida a chave `store-settings` depois da escrita. */
  cache: TenantCache;
  geocoding: GeocodingService;
}

/**
 * Geocoda o endereço do restaurante e grava as coordenadas em `store_settings`.
 */
export async function geocodeRestaurantUsecase(
  deps: GeocodeRestaurantDeps,
): Promise<{
  latitude: number;
  longitude: number;
}> {
  // Leitura do singleton FORA do try, como antes: linha ausente continua
  // propagando o erro do reader (`store_settings não inicializado...`), e não
  // a mensagem genérica de falha de geocodificação.
  const settings = await deps.settings.get();

  const address = `${settings.merchantName}, ${settings.merchantCity}`;

  try {
    const coords = await deps.geocoding.forwardGeocode(address);

    await deps.uow.run(deps.tenant(), async (session) => {
      await session.storeSettings.updateRestaurantCoordinates(coords);
      await session.audit.record({
        actorId: SYSTEM_USER_ID,
        action: "restaurant_geocoded",
        orderId: null,
        details: { latitude: coords.latitude, longitude: coords.longitude },
      });
    });

    // `invalidatePrefix("store-settings")` → `invalidatePattern("store-settings*")`,
    // que casa a chave exata `store-settings` (mesma que `store-settings.usecases`
    // lê/grava) — a semântica do `cache.invalidate("store-settings")` antigo.
    await deps.cache.invalidatePrefix("store-settings");

    return coords;
  } catch (err) {
    throw new Error("Não foi possível geocodificar o endereço do restaurante");
  }
}
