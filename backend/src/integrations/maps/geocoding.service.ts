import type { Coordinates, GeocodedAddress, GeocodingService } from "./types.js";

const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
const REQUEST_TIMEOUT_MS = 5000;
const USER_AGENT = "pdv-delivery-app/1.0";

interface NominatimReverseResponse {
  display_name?: string;
  address?: {
    road?: string;
    house_number?: string;
    suburb?: string;
    neighbourhood?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    postcode?: string;
    municipality?: string;
  };
}

interface NominatimForwardResponse {
  lat: string;
  lon: string;
}

export class NominatimGeocodingService implements GeocodingService {
  async reverseGeocode(coords: Coordinates): Promise<GeocodedAddress> {
    const url = new URL(`${NOMINATIM_BASE_URL}/reverse`);
    url.searchParams.set("format", "json");
    url.searchParams.set("lat", String(coords.latitude));
    url.searchParams.set("lon", String(coords.longitude));
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");

    const response = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Nominatim reverse geocoding failed: ${response.status}`);
    }

    const data: NominatimReverseResponse = await response.json();

    if (!data.address) {
      throw new Error("Nominatim returned no address");
    }

    const addr = data.address;
    const street = addr.road || "";
    const number = addr.house_number || "";
    const neighborhood = addr.suburb || addr.neighbourhood || "";
    const city = addr.city || addr.town || addr.village || addr.municipality || "";
    const state = addr.state || "";
    const postalCode = addr.postcode || "";

    const formattedAddress = [
      street && number ? `${street}, ${number}` : street,
      neighborhood,
      city,
      state,
      postalCode,
    ]
      .filter(Boolean)
      .join(", ");

    return { street, number, neighborhood, city, state, postalCode, formattedAddress };
  }

  async forwardGeocode(address: string): Promise<Coordinates> {
    const url = new URL(`${NOMINATIM_BASE_URL}/search`);
    url.searchParams.set("format", "json");
    url.searchParams.set("q", address);
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "0");

    const response = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Nominatim forward geocoding failed: ${response.status}`);
    }

    const results: NominatimForwardResponse[] = await response.json();

    if (results.length === 0) {
      throw new Error("Nominatim forward geocoding returned no results");
    }

    return {
      latitude: parseFloat(results[0].lat),
      longitude: parseFloat(results[0].lon),
    };
  }
}
