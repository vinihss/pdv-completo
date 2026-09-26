export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface GeocodedAddress {
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  formattedAddress: string;
}

export interface RoutingResult {
  distanceKm: number;
  durationMinutes: number;
}

export interface GeocodingService {
  reverseGeocode(coords: Coordinates): Promise<GeocodedAddress>;
  forwardGeocode(address: string): Promise<Coordinates>;
}

export interface RoutingService {
  calculateRoute(origin: Coordinates, destination: Coordinates): Promise<RoutingResult>;
}
