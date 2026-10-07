import { Linking } from "react-native";

export function mapsUrl(address) {
  const query = String(address ?? "").trim();
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export async function openMapsForAddress(address) {
  const url = mapsUrl(address);
  if (!url) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
