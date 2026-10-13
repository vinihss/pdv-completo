export interface Coordinates { latitude: number; longitude: number }
export interface RouteResult { distanceMeters: number; durationSeconds: number }

export interface GeocodingService {
  geocode(address: string): Promise<Coordinates | null>;
}
export interface RoutingService {
  route(origin: Coordinates, destination: Coordinates): Promise<RouteResult | null>;
}
