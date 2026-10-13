// Cálculo de entrega pública — ONDA 3 da refatoração arquitetural.
//
// Este arquivo é o HUB do contexto delivery e a FACTORY única
// (`createDeliveryUsecases(deps)`) que agrega os três use cases do domínio:
// `calcularEntregaUsecase`, `getDeliveryPricingUsecase` (delivery-pricing) e
// `geocodeRestaurantUsecase` (geocode-restaurant). Nenhuma importação de
// infra/integrations/config nem Drizzle: a persistência passa pelo
// `uow.run`/`session.geocodingCache`, o settings pelo effect port
// `StoreSettingsReader` e geocoding/roteamento pelos ports
// `GeocodingService`/`RoutingService`. A composition root que liga os
// adapters concretos é `src/infra/composition/default-usecases.ts`.
//
// FACTORY ÚNICA, e não três isoladas, porque os três use cases compartilham
// exatamente as mesmas deps (uow, tenant, settings, cache, geocoding, routing)
// e formam um único contexto de entrega — uma composition entry point evita
// repetir o wiring e mantém o seam de teste (`setMapServices`) num só lugar.
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2): as leituras que antes rodavam
// "fora do tx" (`store_settings` + cache de geocoding) agora rodam DENTRO de
// um único `uow.run` por use case. Sob READ COMMITTED o resultado é o mesmo
// (snapshot por statement); o ganho é um caminho só para ler e escrever, sem
// meio-commit. `validateCoordinates` continua FORA da janela (input inválido
// não abre transação).
import crypto from "node:crypto";
import { Errors } from "../../domain/errors.js";
import type { GeocodingService, RoutingService, TenantCache } from "../ports/effects.js";
import type { StoreSettingsReader } from "../ports/effects.js";
import type { Coordinates, GeocodedAddress, RoutingResult } from "../ports/effects.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import {
  applyDeliveryPricing,
  deliveryPricingFrom,
  getDeliveryPricingUsecase,
  type DeliveryPricingDeps,
} from "./delivery-pricing.usecase.js";
import { geocodeRestaurantUsecase } from "./geocode-restaurant.usecase.js";

const CACHE_TTL_DAYS = 30;

export interface CalcularEntregaInput {
  latitude: number;
  longitude: number;
  itemsTotal?: number;
}

export interface CalcularEntregaResult {
  disponivel: boolean;
  motivo?: string;
  endereco: GeocodedAddress;
  localizacao: Coordinates;
  entrega: {
    distanciaKm: number;
    tempoMinutos: number;
    frete: number;
    moeda: string;
  };
}

function validateCoordinates(latitude: number, longitude: number) {
  if (typeof latitude !== "number" || isNaN(latitude) || latitude < -90 || latitude > 90) {
    throw Errors.validationFailed({ field: "latitude", reason: "deve estar entre -90 e 90" });
  }
  if (typeof longitude !== "number" || isNaN(longitude) || longitude < -180 || longitude > 180) {
    throw Errors.validationFailed({ field: "longitude", reason: "deve estar entre -180 e 180" });
  }
}

function cacheKey(coords: Coordinates): string {
  const rounded = `${coords.latitude.toFixed(5)},${coords.longitude.toFixed(5)}`;
  return crypto.createHash("sha256").update(rounded).digest("hex");
}

export interface CalcularEntregaDeps extends DeliveryPricingDeps {
  geocoding: GeocodingService;
  routing: RoutingService;
}

export async function calcularEntregaUsecase(
  deps: CalcularEntregaDeps,
  input: CalcularEntregaInput,
): Promise<CalcularEntregaResult> {
  validateCoordinates(input.latitude, input.longitude);

  return deps.uow.run(deps.tenant(), async (session) => {
    const settings = await deps.settings.get();

    if (settings.restaurantLat == null || settings.restaurantLong == null) {
      throw Errors.validationFailed({ reason: "restaurante sem coordenadas configuradas" });
    }

    const customerCoords: Coordinates = { latitude: input.latitude, longitude: input.longitude };
    const restaurantCoords: Coordinates = { latitude: settings.restaurantLat, longitude: settings.restaurantLong };

    const key = cacheKey(customerCoords);
    const cached = await session.geocodingCache.find(key);
    let endereco: GeocodedAddress | null =
      cached && new Date(cached.expiresAt) >= new Date()
        ? (JSON.parse(cached.response) as GeocodedAddress)
        : null;

    if (!endereco) {
      try {
        endereco = await deps.geocoding.reverseGeocode(customerCoords);
        const now = new Date();
        const expires = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
        await session.geocodingCache.upsert({
          cacheKey: key,
          response: JSON.stringify(endereco),
          expiresAt: expires.toISOString(),
        });
      } catch (err) {
        throw Errors.validationFailed({ reason: "Não foi possível identificar o endereço" });
      }
    }

    let routing: RoutingResult;
    try {
      routing = await deps.routing.calculateRoute(restaurantCoords, customerCoords);
    } catch (err) {
      throw Errors.validationFailed({ reason: "Não foi possível calcular a rota" });
    }

    // O settings já está em mãos (lido nesta mesma janela): resolve as faixas
    // aqui com `deliveryPricingFrom` em vez de chamar `getDeliveryPricingUsecase`,
    // que abriria uma segunda transação a partir de dentro desta.
    const { tiers, freeDeliveryMin } = deliveryPricingFrom(settings);
    const pricing = applyDeliveryPricing(tiers, freeDeliveryMin, {
      distanceKm: routing.distanceKm,
      itemsTotal: input.itemsTotal ?? 0,
    });

    if (pricing.outOfRange) {
      return {
        disponivel: false,
        motivo: "Endereço fora da área de entrega",
        endereco,
        localizacao: customerCoords,
        entrega: {
          distanciaKm: routing.distanceKm,
          tempoMinutos: routing.durationMinutes,
          frete: 0,
          moeda: "BRL",
        },
      };
    }

    return {
      disponivel: true,
      endereco,
      localizacao: customerCoords,
      entrega: {
        distanciaKm: routing.distanceKm,
        tempoMinutos: routing.durationMinutes,
        frete: pricing.fee,
        moeda: "BRL",
      },
    };
  });
}

// ---------- factory ----------

/**
 * Deps do contexto delivery: Unit-of-Worker + tenant resolvido POR CHAMADA +
 * os effects (settings, cache por schema, geocoding e roteamento). Nada de
 * infra concreta aqui — quem instancia é a composition root
 * (`infra/composition/default-usecases.ts`).
 */
export interface DeliveryUsecasesDeps extends CalcularEntregaDeps {
  /** Cache por schema — usado só pelo `geocodeRestaurantUsecase`. */
  cache: TenantCache;
}

/**
 * Os três use cases do contexto delivery. Os nomes legados
 * (`calcularEntregaUsecase(...)`, `geocodeRestaurantUsecase()` etc.) são
 * re-exportados por `infra/composition/default-usecases.ts` para os
 * consumidores que ainda não recebem deps por parâmetro.
 */
export function createDeliveryUsecases(deps: DeliveryUsecasesDeps) {
  return {
    calcularEntregaUsecase: (input: CalcularEntregaInput) => calcularEntregaUsecase(deps, input),
    getDeliveryPricingUsecase: () => getDeliveryPricingUsecase(deps),
    geocodeRestaurantUsecase: () => geocodeRestaurantUsecase(deps),
  };
}

export type DeliveryUsecases = ReturnType<typeof createDeliveryUsecases>;
