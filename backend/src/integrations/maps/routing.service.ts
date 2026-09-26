import type { Coordinates, RoutingResult, RoutingService } from "./types.js";

const OSRM_BASE_URL = "https://router.project-osrm.org";
const REQUEST_TIMEOUT_MS = 5000;

interface OSRMResponse {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
  }>;
}

export class OsmRoutingService implements RoutingService {
  async calculateRoute(origin: Coordinates, destination: Coordinates): Promise<RoutingResult> {
    const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const url = `${OSRM_BASE_URL}/route/v1/driving/${coords}?overview=false`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`OSRM routing failed: ${response.status}`);
    }

    const data: OSRMResponse = await response.json();

    if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
      throw new Error(`OSRM routing returned no route (code: ${data.code})`);
    }

    const route = data.routes[0];

    return {
      distanceKm: Math.round((route.distance / 1000) * 10) / 10,
      durationMinutes: Math.ceil(route.duration / 60),
    };
  }
}
