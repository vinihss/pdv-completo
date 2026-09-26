import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { geocodingCache, storeSettings } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { NominatimGeocodingService } from "../../integrations/maps/geocoding.service.js";
import { OsmRoutingService } from "../../integrations/maps/routing.service.js";
import type { GeocodingService, RoutingService } from "../../integrations/maps/types.js";
import type { Coordinates, GeocodedAddress, RoutingResult } from "../../integrations/maps/types.js";
import { applyDeliveryPricing, getDeliveryPricingUsecase, type DeliveryFeeTier } from "./delivery-pricing.usecase.js";

const CACHE_TTL_DAYS = 30;

let geocodingService: GeocodingService = new NominatimGeocodingService();
let routingService: RoutingService = new OsmRoutingService();

export function setMapServices(geocoding: GeocodingService, routing: RoutingService) {
  geocodingService = geocoding;
  routingService = routing;
}

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

async function getCachedGeocoding(key: string): Promise<GeocodedAddress | null> {
  const cached = await db.query.geocodingCache.findFirst({
    where: eq(geocodingCache.cacheKey, key),
  });
  if (!cached) return null;
  if (new Date(cached.expiresAt) < new Date()) return null;
  return JSON.parse(cached.response) as GeocodedAddress;
}

async function setCachedGeocoding(key: string, address: GeocodedAddress) {
  const now = new Date();
  const expires = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db
    .insert(geocodingCache)
    .values({
      cacheKey: key,
      response: JSON.stringify(address),
      expiresAt: expires.toISOString(),
    })
    .onConflictDoUpdate({
      target: geocodingCache.cacheKey,
      set: { response: JSON.stringify(address), expiresAt: expires.toISOString() },
    });
}

export async function calcularEntregaUsecase(input: CalcularEntregaInput): Promise<CalcularEntregaResult> {
  validateCoordinates(input.latitude, input.longitude);

  const settings = await db.query.storeSettings.findFirst();
  if (!settings) throw new Error("store_settings não inicializado");

  if (settings.restaurantLat == null || settings.restaurantLong == null) {
    throw Errors.validationFailed({ reason: "restaurante sem coordenadas configuradas" });
  }

  const customerCoords: Coordinates = { latitude: input.latitude, longitude: input.longitude };
  const restaurantCoords: Coordinates = { latitude: settings.restaurantLat, longitude: settings.restaurantLong };

  const key = cacheKey(customerCoords);
  let endereco = await getCachedGeocoding(key);

  if (!endereco) {
    try {
      endereco = await geocodingService.reverseGeocode(customerCoords);
      await setCachedGeocoding(key, endereco);
    } catch (err) {
      throw Errors.validationFailed({ reason: "Não foi possível identificar o endereço" });
    }
  }

  let routing: RoutingResult;
  try {
    routing = await routingService.calculateRoute(restaurantCoords, customerCoords);
  } catch (err) {
    throw Errors.validationFailed({ reason: "Não foi possível calcular a rota" });
  }

  const { tiers, freeDeliveryMin } = await getDeliveryPricingUsecase();
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
}
