import type {
  Coordinates,
  RoutingResult,
  RoutingService as RoutingServicePort,
} from "../../application/ports/effects.js";
import { OsmRoutingService } from "./routing.service.js";
import type { RoutingService } from "./types.js";

/**
 * Adapter do port `RoutingService` (ports/effects.ts) — FASE 0.
 *
 * Adaptador fino, mesmo raciocínio do `geocoding-port-adapter.ts`: tipos do
 * port estruturalmente idênticos aos de `maps/types.ts`, delegação direta, e
 * a ponte serve de seam (divergência de tipos aparece compilando aqui).
 */
export class RoutingPortAdapter implements RoutingServicePort {
  /** `OsmRoutingService` por default (stateless); injetável para teste/dublê. */
  constructor(private readonly service: RoutingService = new OsmRoutingService()) {}

  calculateRoute(origin: Coordinates, destination: Coordinates): Promise<RoutingResult> {
    return this.service.calculateRoute(origin, destination);
  }
}
