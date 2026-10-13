import type {
  Coordinates,
  GeocodedAddress,
  GeocodingService as GeocodingServicePort,
} from "../../application/ports/effects.js";
import { NominatimGeocodingService } from "./geocoding.service.js";
import type { GeocodingService } from "./types.js";

/**
 * Adapter do port `GeocodingService` (ports/effects.ts) — FASE 0.
 *
 * Adaptador fino: os tipos do port (`Coordinates`/`GeocodedAddress`) são
 * estruturalmente idênticos aos de `maps/types.ts`, então a delegação é
 * direta, sem tradução de campos. A ponte existe como SEAM explícita — se os
 * tipos do módulo concreto divergirem do port, o compilador acusa aqui, uma
 * vez só, em vez de em cada use case migrado.
 */
export class GeocodingPortAdapter implements GeocodingServicePort {
  /** `NominatimGeocodingService` por default (stateless); injetável para teste/dublê. */
  constructor(private readonly service: GeocodingService = new NominatimGeocodingService()) {}

  reverseGeocode(coords: Coordinates): Promise<GeocodedAddress> {
    return this.service.reverseGeocode(coords);
  }

  forwardGeocode(address: string): Promise<Coordinates> {
    return this.service.forwardGeocode(address);
  }
}
